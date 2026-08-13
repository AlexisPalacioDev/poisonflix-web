import { useEffect, useRef } from 'react';
import { reportFailure } from '../../lib/obs/report';
import { timeRangeEnd } from './musicPlayerCore';
import type { AudioRouting, KeepaliveContextState } from './silentKeepalive';

// Why this exists: the defect only happens on the owner's iPhone, when he
// locks it. There is no iOS simulator on Linux, driving a real iPhone needs a
// Mac to sign the automation, and — the part that settles it — locking the
// screen is a physical act no debugger can trigger. The failure cannot be
// reproduced from here at all.
//
// So the phone reports instead. While something is playing, the interesting
// media events go into a small ring buffer; if the audio stops while the page
// is hidden — which is exactly "the music died when I locked it" — the buffer
// is shipped to /bff/client-log. One lock produces one trace, and the trace
// names the event that actually killed it rather than the one I guessed.
//
// Deliberately narrow: it records nothing while paused, ships nothing on a
// normal foreground pause, and holds at most a handful of entries.

const TRACE_MAX = 24;

/** Events worth knowing about. `suspend` and `emptied` are in the list because
 *  they are what a browser fires when it decides on its own to let go of the
 *  resource — the shape of failure a lock would produce. */
const MEDIA_EVENTS = [
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'suspend',
  'emptied',
  'ended',
  'error',
  'ratechange',
] as const;

/**
 * Identifies which track a trace belongs to. Read live off a ref rather than
 * passed as a reactive value: 31 real traces had to be matched back to a
 * track by proximity to a server timestamp alone, because nothing here said
 * which track was playing. That ref must stay fresh across every event this
 * hook records without forcing a resubscribe on every ordinary track change
 * (see `audioIdentityKey` below for what SHOULD force a resubscribe).
 */
export interface LockDiagnosticsTrackRef {
  current: { itemId: string | null; videoId: string | null };
}

export function useLockDiagnostics(
  audioRef: { current: HTMLAudioElement | null },
  trackRef: LockDiagnosticsTrackRef,
  // Double buffering (see MusicPlayerProvider's preload effect) can re-point
  // `audioRef.current` at a DIFFERENT physical <audio> element mid-session,
  // when a preloaded next track is promoted to active instead of reusing the
  // element that just finished. `audioRef` itself is a stable ref object —
  // mutating `.current` does not re-run an effect keyed on it — so this hook
  // needs an explicit, reactive signal to know when to tear down the old
  // element's listeners and attach to the new one. Bump this value exactly
  // when (and only when) that swap happens; an ordinary track load on the
  // SAME element must NOT bump it, or every track change would reset the
  // trace buffer and lose the lead-up context to a hang that started right at
  // a track boundary.
  audioIdentityKey: number,
  // Read live (same reasoning as `trackRef`, not passed as a reactive value)
  // so every sample reports today's keepalive state without forcing a
  // resubscribe. Optional so any caller other than MusicPlayerProvider (e.g.
  // a narrower future test) is not forced to wire up a keepalive it may not
  // have — the field is simply omitted from every sample when absent.
  keepaliveStateRef?: { current: () => KeepaliveContextState },
  // Read live, same as `keepaliveStateRef`. Answers the one question a
  // "it says it is playing but there is no sound" report cannot answer
  // otherwise: was this element's audio leaving through the keepalive's graph
  // or straight out of the element? Without it, a trace of a silent-but-
  // advancing track cannot distinguish a dead audio graph from every other
  // cause of silence, which is exactly the ambiguity that let one such report
  // be diagnosed twice from code alone.
  routingRef?: { current: () => { routing: AudioRouting; escaped: boolean; mode: boolean } },
  // Filled in BY this hook with its own `push`, so the provider can record
  // things only it can see — above all, WHY a play() was refused.
  //
  // The last round of traces could say the element ended up paused at t=0 with
  // the track fully buffered, but not whether iOS had refused the play() or
  // whether one was ever made. Those are different bugs with different fixes,
  // and telling them apart cost a whole deploy cycle. The rejection reason
  // belongs in the ring buffer, in order, next to the events around it —
  // `reportFailure` on its own lands in a separate log line with no context.
  notePushRef?: { current: ((what: string, extra?: Record<string, unknown>) => void) | null },
): void {
  // Lives OUTSIDE the effect below, in a ref that survives a resubscribe —
  // caught by adversarial review: an earlier version declared this as a
  // plain local inside the effect body, so every `audioIdentityKey` bump
  // (i.e. every double-buffering promotion) silently emptied it. Promotion
  // only ever happens for the exact population under investigation (a
  // `streamUrl` preview track — the only kind that gets preloaded), so that
  // version lost the lead-up context at PRECISELY the track boundary the
  // hook exists to explain, which is the opposite of what the "don't
  // resubscribe on an ordinary track change" design was trying to protect.
  // Hoisting it here means the effect can tear down and re-attach listeners
  // to the newly-active element while the accumulated samples ride along
  // unchanged.
  const traceRef = useRef<Array<Record<string, unknown>>>([]);
  // When the element last reported real, flowing audio (`playing`), and where
  // its clock was at the previous sample. Both answer the question the last
  // traces could not: is this silence a stopped element, or an element that
  // still believes it is advancing? They live in refs so they survive the
  // resubscribe that a rotation forces.
  const lastPlayingAtRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || typeof document === 'undefined') return;

    const trace = traceRef.current;
    const push = (what: string, extra?: Record<string, unknown>) => {
      trace.push({
        at: Date.now(),
        what,
        t: Number(audio.currentTime.toFixed(2)),
        paused: audio.paused,
        hidden: document.visibilityState === 'hidden',
        ready: audio.readyState,
        rate: audio.playbackRate,
        // The track this sample is about. Its absence was the first gap: 31
        // real traces had to be cross-referenced against the proxy's own logs
        // by clock proximity alone to figure out which track a hang belonged
        // to. Read from the ref (not a closed-over value) so it's always
        // today's track even though this effect intentionally does NOT
        // resubscribe on every track change.
        itemId: trackRef.current.itemId,
        videoId: trackRef.current.videoId,
        // The second gap: `paused` and `mediaSessionState` are both blind to
        // a silent stall — the traced hangs sat with `paused=false` and a
        // lock screen that kept saying 'playing' through 60-110s of true
        // silence. `buffered`'s end is the one signal that actually reports
        // whether bytes are still arriving; a hang shows this value frozen
        // across every sample from the last `stalled` onward, where a merely
        // slow-but-live load keeps advancing it. Read through the shared
        // `timeRangeEnd` guard — `TimeRanges.end()` throws `IndexSizeError`
        // on an empty range, which is the normal state before any data has
        // arrived at all.
        bufferedEnd: timeRangeEnd(audio.buffered),
        // What the OS itself believes about the session — 'none' | 'paused' |
        // 'playing'. This is the piece the earlier traces lacked: they showed
        // the element's own state but not whether the lock screen agreed with
        // it, which is exactly the gap that let a false "incognito" theory
        // stand in for a measurement. Not every browser exposes
        // `mediaSession`, and jsdom (tests) does not either.
        mediaSessionState:
          'mediaSession' in navigator ? navigator.mediaSession.playbackState : undefined,
        // The silent Web Audio keepalive's own state ('running' | 'suspended'
        // | 'closed' | null) — see silentKeepalive.ts. Not proven to prevent
        // the hang; recorded so a future trace can at least say whether the
        // keepalive was still alive when playback died, instead of that being
        // one more unanswerable question.
        keepaliveState: keepaliveStateRef ? keepaliveStateRef.current() : undefined,
        // 'graph' = this element's sound is being carried by the keepalive's
        // AudioContext; 'direct' = it leaves the element itself. `escaped` is
        // true once the graph was declared unable to carry sound and playback
        // was handed to a never-routed element (see `escapeFromAudioGraph`).
        routing: routingRef ? routingRef.current().routing : undefined,
        graphEscaped: routingRef ? routingRef.current().escaped : undefined,
        // Which side of the routing experiment this sample belongs to — see
        // `graphRoutingEnabled`. A 'direct' reading is otherwise ambiguous.
        routeMode: routingRef ? (routingRef.current().mode ? 'graph' : 'off') : undefined,
        // Seconds since the element last said audio was actually flowing. A
        // stall traced 90s after the last `playing` is a different animal from
        // one traced 2s after it, and no previous trace could tell them apart.
        sincePlaying:
          lastPlayingAtRef.current === null
            ? null
            : Number(((Date.now() - lastPlayingAtRef.current) / 1000).toFixed(1)),
        // Whether the clock moved since the previous sample. This is what
        // separates "the element stopped" from "the element is advancing
        // through silence" — the second is the signature of audio being fed
        // into a graph that can no longer carry it.
        advanced:
          lastTimeRef.current === null ? null : audio.currentTime > lastTimeRef.current + 0.01,
        ...extra,
      });
      lastTimeRef.current = audio.currentTime;
      if (what === 'playing') lastPlayingAtRef.current = Date.now();
      if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
    };

    const ship = (reason: string) => {
      if (trace.length === 0) return;
      const snapshot = trace.slice();
      trace.length = 0;
      reportFailure('music.lock.trace', reason, snapshot);
    };

    const onMedia = (event: Event) => {
      push(event.type);
      // The moment that matters: playback stopped while the screen was off.
      // A pause the user made in the foreground is not interesting and is not
      // reported, so this stays quiet during normal use.
      if ((event.type === 'pause' || event.type === 'suspend' || event.type === 'emptied') &&
        document.visibilityState === 'hidden') {
        ship(`${event.type}-while-hidden`);
      }
    };

    const onVisibility = () => {
      push(`visibility:${document.visibilityState}`);
      // Coming back to a page whose audio died while away: ship what happened
      // in between, since the user is about to notice it anyway.
      if (document.visibilityState === 'visible' && audio.paused) ship('returned-to-silence');
    };

    for (const type of MEDIA_EVENTS) audio.addEventListener(type, onMedia);
    document.addEventListener('visibilitychange', onVisibility);
    if (notePushRef) notePushRef.current = push;
    return () => {
      for (const type of MEDIA_EVENTS) audio.removeEventListener(type, onMedia);
      document.removeEventListener('visibilitychange', onVisibility);
      // Dropped on teardown so a note can never be pushed into the buffer of
      // an element this hook is no longer watching.
      if (notePushRef) notePushRef.current = null;
    };
    // `trackRef` is a ref object (stable identity, read live inside `push`)
    // and is deliberately NOT a dependency — see `audioIdentityKey`'s
    // docstring for why an ordinary track change must not resubscribe this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRef, audioIdentityKey]);
}
