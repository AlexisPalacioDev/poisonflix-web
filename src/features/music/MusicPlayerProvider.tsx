import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { useAuth } from '../../hooks/useAuth';
import { getAutoplayPreference, setAutoplayPreference } from '../../lib/domain/musicPrefs';
import { streamUrlSource } from '../../lib/domain/musicTrack';
import { buildAudioStreamUrl } from '../../lib/domain/streamResolver';
import { useLockDiagnostics } from './useLockDiagnostics';
import { type AudioRouting, type KeepaliveContextState } from './silentKeepalive';
import { createMusicAudioEngine, graphRoutingEnabled } from './musicAudioEngine';
import { placeholderToneClip, silentAudioClip } from './silentAudioClip';
import { jamDestination } from '../jam/destination';
import { addTracksToJam } from '../../api/jam';
import { warmMusicTrack } from '../../api/music';
import { reportFailure } from '../../lib/obs/report';
import {
  BUFFERING_SETTLE_MS,
  MusicPlayerContext,
  currentIndexOf,
  durationMismatch,
  initialState,
  naturalOrder,
  reducer,
  shouldForceAdvance,
  shuffleOrder,
  timeRangeEnd,
  visibleBuffering,
  type Action,
  type MusicPlayerContextValue,
  type MusicTrack,
} from './musicPlayerCore';

// The <audio> element and everything that drives it. State lives in
// `musicPlayerCore`; this module exports the component and nothing else, so
// Fast Refresh can hot-swap it without tearing down playback.


// Build the MediaSession artwork list from a track's Jellyfin cover URL. The
// cover URL already carries a `maxWidth` query param (see `jellyfinPosterUrl`),
// so we swap it to request a few lock-screen-friendly resolutions off the same
// image and let iOS/Android pick. Reusing the exact URL the UI renders (same
// authenticated `api_key`) guarantees the artwork actually resolves.
function mediaSessionArtwork(coverUrl: string | null): MediaImage[] {
  if (!coverUrl) return [];
  if (!/[?&]maxWidth=\d+/.test(coverUrl)) {
    return [{ src: coverUrl, sizes: '512x512', type: 'image/jpeg' }];
  }
  return [96, 256, 512].map((px) => ({
    src: coverUrl.replace(/([?&])maxWidth=\d+/, `$1maxWidth=${px}`),
    sizes: `${px}x${px}`,
    type: 'image/jpeg',
  }));
}

// Two dead tracks in a row is a broken upstream, not a broken file.
const MAX_CONSECUTIVE_AUDIO_ERRORS = 3;

// Milliseconds to wait, after calling play(), before treating the element as
// genuinely stalled rather than merely slow. 31 real on-device traces (iPhone,
// iOS 18.7 Safari) of auto-advance with the screen locked: healthy
// transitions took 1-2s, degraded-but-alive ones took 18-35s, and every
// transition that ran past that window never recovered on its own within the
// 60-110s the owner watched it sit in total silence — no further event at
// all. 40s sits comfortably above the slowest LIVE load actually measured
// (35s), so a legitimately slow-but-working load is never mistaken for a
// stall — see the "does not fire on a slow-but-live load" test, which matters
// as much as the "does fire on a real stall" one.
const STALL_WATCHDOG_MS = 40_000;
// Grace window for the single retry (load()+play() again after the first
// timeout). None of the measured hangs recovered on their own even after
// 60-110s of silence, so there is no evidence a retry needs the full 40s to
// prove itself alive — if it hasn't reached `playing` by 15s, waiting longer
// only extends dead air.
const STALL_RETRY_GRACE_MS = 15_000;
// How many keepalive routing/context transitions to keep for the escape
// report. Enough to show the run-up (routed -> running -> interrupted ->
// lost); not so many that a long session ships a wall of noise.
const KEEPALIVE_EVENT_LOG_MAX = 24;
// How many times one URL may fail to preload before it is left alone until it
// stops being adjacent. Two, because the failures measured on the owner's
// device were not transient — 94 attempts at the same track all failed with
// the same `MEDIA_ERR_SRC_NOT_SUPPORTED`. One retry covers a genuine blip; a
// third would only be more noise on a connection that playback needs.
const MAX_PRELOAD_FAILURES = 2;
// How many times a pause we did not ask for, while the page is hidden, may be
// answered by resuming. The owner's traces contain 19 `pause-while-hidden`
// samples: iOS stops the element on its own and nothing ever starts it again,
// so the music is simply over until he picks the phone up. Answering that
// pause from the event's own task is the one moment the browser still lets us
// act (the same reason auto-advance lives there).
//
// Bounded because the alternative to "give up too early" is "fight the OS
// forever": if iOS is pausing because a call came in or the session is truly
// gone, each retry is refused and a loop would just burn battery. Three is
// enough to ride out a transient stop and few enough to stay quiet after a
// real one. Reset on every confirmed `playing`.
const MAX_HIDDEN_RESUME_ATTEMPTS = 3;
// How much longer than its own timeout a watchdog timer may take before its
// firing is treated as a thawed backlog rather than a real stall. 1.5x leaves
// room for ordinary scheduler jitter while catching the case that actually
// happened: timers frozen for minutes and released together the moment the
// phone woke up.
const STALL_TIMER_LATE_RATIO = 1.5;
// How close to the end a seek has to land before it is read as "take me to the
// end of this track" rather than "play the last fraction of a second". A
// lock-screen scrubber dragged to the right edge does not report the duration
// exactly, and nobody aims for the last quarter-second of a song on purpose.
const SEEK_TO_END_EPSILON_SECONDS = 0.25;

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Where "the element that is playing" and "the element buffering what comes
  // next" are read from. NEITHER is tied 1:1 to a fixed JSX node: the mixer
  // rotates roles between three peer slots, so both are mirrors of whatever
  // the engine currently calls `current` and `next`, refreshed by
  // `syncActiveElement`. Every other reference to `audioRef.current` in this
  // file keeps working unmodified across a rotation because of that.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preloadAudioRef = useRef<HTMLAudioElement | null>(null);
  // ── THE MIXER ────────────────────────────────────────────────────────────
  //
  // Slots A/B/C belong to `musicAudioEngine`, which owns the AudioContext, the
  // silent tone, and which of the three is audible. It is what made the src
  // reassignment disappear: a track change is a role rotation between
  // already-buffered elements, so the element that is sounding never gets a
  // new `src` and never passes through the `emptied` -> `load` -> `play` gap
  // that iOS reclaims the audio session during.
  //
  // `audioRef` stays as a MIRROR of the engine's current element rather than
  // being replaced by `engine.getCurrent()` everywhere: every media handler,
  // the stall watchdog, the seek effect, MediaSession and the diagnostics hook
  // already route on `audioRef.current`, and the mirror keeps that contract
  // intact — the same indirection the old promotion used, with one owner.
  const engineSlotsRef = useRef<Array<HTMLAudioElement | null>>([null, null, null]);
  // The FOURTH element, and the reason there are four rather than three. The
  // song is routed into the engine's AudioContext so the tone and the song
  // leave through one origin — and that bind is irreversible (see
  // silentKeepalive.ts's "ONE AUDIO ORIGIN" note): a routed element can never
  // be handed back to the speaker, not by disconnecting it, not by a second
  // context, not by anything.
  //
  // WHY IT CANNOT BE ONE OF THE THREE: the mixer rotates roles, so over a
  // session every slot ends up being the playing element, and every slot
  // therefore has to be routed for the "one origin" property to hold on every
  // track rather than every third one. Reserving one of them would mean either
  // a third of the tracks leaving through a second origin — the exact thing
  // this removes — or giving up a preload direction.
  //
  // The cost, stated plainly: once the escape happens, all three mixer slots
  // are captive for the rest of the page load and playback continues
  // single-buffered on the escape element. Sound without preloading beats
  // preloading without sound.
  const escapeAudioRef = useRef<HTMLAudioElement | null>(null);
  // React hands these back one at a time, in JSX order, and with null on
  // unmount — so the engine cannot be attached until all three have arrived.
  // Collect them here, then attach once the set is complete (`attach` itself
  // keeps no memory between partial calls, by design).
  const setEngineSlot = useCallback(
    (index: 0 | 1 | 2) => (el: HTMLAudioElement | null) => {
      engineSlotsRef.current[index] = el;
      const slots = engineSlotsRef.current;
      engineRef.current?.attach(slots);
      // Never take the active element back from the escape one. After an
      // escape the engine's `current` is a captive, mute slot, and the escape
      // is one-way — so a Fast Refresh or a remount that re-ran these
      // callbacks would silently hand playback to something that cannot sound,
      // with no way back. Same guard, same reason, as `syncActiveElement`.
      if (engineRef.current?.isEscaped()) return;
      audioRef.current = engineRef.current?.getCurrent() ?? slots[0];
      preloadAudioRef.current = engineRef.current?.getElement('next') ?? slots[1];
    },
    [],
  );
  const setSlotA = useMemo(() => setEngineSlot(0), [setEngineSlot]);
  const setSlotB = useMemo(() => setEngineSlot(1), [setEngineSlot]);
  const setSlotC = useMemo(() => setEngineSlot(2), [setEngineSlot]);
  const setSlotD = useCallback((el: HTMLAudioElement | null) => {
    escapeAudioRef.current = el;
  }, []);
  // THE TONE, as an actual <audio> element — the owner's original design,
  // implemented the way he described it rather than the way it was inherited.
  //
  // It was a Web Audio graph (AudioContext -> gain 0 -> looping buffer), and
  // that is NOT an HTMLMediaElement, so iOS never treats it as a now-playing
  // session. Which is exactly the complaint: after tapping a song there are
  // 5-10 seconds where the phone cannot be locked, because as far as the OS is
  // concerned this page is not playing anything until the real track's bytes
  // arrive and it starts. His intent was the opposite — "que esto empiece a
  // sonar incluso antes de que se carguen los datos de la canción solicitada"
  // — and only a media element can do that.
  //
  // So: a real element, looping embedded silence, started inside the gesture
  // BEFORE the track is even resolved. From that instant the OS has a session
  // to show and the screen can be locked; the song joins when it is ready.
  const toneRef = useRef<HTMLAudioElement | null>(null);
  const setToneSlot = useCallback((el: HTMLAudioElement | null) => {
    toneRef.current = el;
  }, []);
  /** Start the placeholder. Safe to call repeatedly; never throws. */
  const startTone = useCallback(() => {
    const tone = toneRef.current;
    if (!tone) return;
    try {
      if (!tone.getAttribute('src')) {
        // NOT `silentAudioClip()`. That one is digital silence lasting 50ms —
        // right for satisfying a per-element unlock, wrong for holding a
        // now-playing session, and on the owner's phone it produced no
        // lock-screen panel at all. See `placeholderToneClip` for why: WebKit
        // does not owe a session to a page playing a flat line.
        const clip = placeholderToneClip();
        if (!clip) return;
        tone.src = clip;
        tone.loop = true;
      }
      if (tone.paused) {
        const p = tone.play();
        if (p && typeof p.then === 'function') p.catch(() => {});
      }
    } catch {
      // The tone is a cushion, never a dependency: if it cannot run, real
      // playback must be completely unaffected.
    }
  }, []);
  /** Stop it once real audio is confirmed flowing — two elements sounding at
   *  once is how `92b215f` lost the audio route, and the tone has no business
   *  competing with the track it exists to cover for. */
  const stopTone = useCallback(() => {
    const tone = toneRef.current;
    if (!tone) return;
    try {
      if (!tone.paused) tone.pause();
    } catch {
      /* nothing to do */
    }
  }, []);

  /** Tell the OS what the song is doing FROM THE EVENT'S OWN TASK.
   *
   *  There is a `playbackState` effect further down, and it stays — it is the
   *  reconciler, and the only thing that can say 'none'. But an effect is a
   *  React render away, and a backgrounded tab does not reliably get there in
   *  time.
   *
   *  MEASURED, on the owner's phone, build `f17f358`: across the traces every
   *  single one of the 20 `playing` events — the moment audio actually starts
   *  coming out — was sampled with `playbackState` still reading 'paused',
   *  while all 17 `play` events (asked, not yet sounding) read 'playing'. The
   *  control was reporting the previous cycle's answer, which is why it looked
   *  inverted: pause showing while the song ran, play showing while it did not.
   *
   *  Media events DO arrive while hidden, so publishing from them closes that
   *  window without depending on React getting scheduled. */
  const publishPlaybackState = useCallback((playing: boolean) => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch {
      /* Older WebKit rejects the assignment; the effect still reconciles. */
    }
  }, []);

  const lastTickRef = useRef(0);
  // Consecutive <audio> failures. Reset by a successful load; see onError below.
  const consecutiveErrorsRef = useRef(0);
  // Unrequested hidden pauses answered since the last confirmed `playing`.
  const hiddenResumesRef = useRef(0);
  // Set immediately before any pause THIS FILE asks for, and consumed by the
  // resulting `pause` event.
  //
  // Without it, pressing pause on the lock screen produced an endless
  // pause/play flutter: the resume-when-hidden rule cannot tell a pause the
  // listener asked for from one the OS imposed, and while the screen is off
  // BOTH arrive as the same event with the same state — `stateRef` still says
  // playing, because the dispatch that says otherwise has not been applied
  // yet. So it answered the user's own pause by resuming, which produced
  // another pause, and around it went.
  //
  // Same shape as `probeRef` above and for the same reason: intent is not
  // recoverable from a media event, so it has to be recorded at the call site.
  const intentionalPauseRef = useRef(false);
  /** Pause `el` and mark it as ours, so `handlePause` does not fight it. */
  const pauseIntentionally = useCallback((el: HTMLAudioElement | null) => {
    if (!el || el.paused) return;
    intentionalPauseRef.current = true;
    try {
      el.pause();
    } catch {
      intentionalPauseRef.current = false;
    }
  }, []);
  const [autoplay, setAutoplayState] = useState(getAutoplayPreference);
  const { session } = useAuth();

  // A live mirror of state so gesture handlers can resolve the next/prev/current
  // target synchronously (inside the user-activation call stack) without reading
  // a stale closure. Mutating a ref during render is safe: it's a pure snapshot,
  // never read during the same render, only later from event handlers/effects.
  const stateRef = useRef(state);
  stateRef.current = state;
  // The stream URL currently assigned to the element. iOS requires the very
  // first play() to run synchronously inside the gesture, so gesture handlers
  // set `audio.src` + call play() imperatively; this ref lets the declarative
  // src-effect below detect "already loaded" and avoid a competing load() that
  // would cancel/restart the gesture-initiated play.
  const srcUrlRef = useRef<string | null>(null);
  // The URL currently loaded (or being loaded) into the PRELOAD element, or
  // null when nothing is preloaded. Set only by the preload effect below;
  // owned by the engine now; this ref survives only as the gesture path's
  // "what did we last ask for" guard.
  const preloadedUrlRef = useRef<string | null>(null);
  // Flips true after the element has successfully played once. From that point
  // the media element is unlocked, so a later rejected play() must NOT silently
  // flip isPlaying back to paused (that only guards the genuine pre-unlock
  // autoplay block on iOS).
  const unlockedRef = useRef(false);
  // Open synchronously right before the unlock probe's own play(), closed
  // FROM the resulting `pause` event handler — never in a `.then()`/`.catch()`
  // microtask, which would race ahead of the `pause` event's task and let the
  // probe's own pause leak through as a reconciled user pause. `unlockedRef`
  // cannot serve this role: it is already `true` by the time the probe runs.
  const probeRef = useRef(false);
  // Arms the 600ms buffering-settle window (see BUFFERING_SETTLE_MS); cleared
  // on `playing`/`canplay` and on unmount.
  const bufferingTimerRef = useRef<number | null>(null);
  // The track key (itemId) a duration-mismatch report was already sent for —
  // at most one report per track load. Reset in the currentSrc effect below.
  const durationReportedRef = useRef<string | null>(null);
  // The track key (itemId) already reported for having played past its known
  // length — at most one report per track load (see `shouldForceAdvance` and
  // the observe-only block below). Reset alongside `durationReportedRef` in
  // the currentSrc effect.
  const pastKnownDurationRef = useRef<string | null>(null);

  // True once playback has been handed off to the never-routed escape element
  // (the escape element). One-way: the two double-buffer elements are captive from that
  // point on, so promotion and preloading must both stop. Mirrored into React
  // state below because the preload effect is keyed on a derived value.
  const graphEscapedRef = useRef(false);
  const [graphEscaped, setGraphEscaped] = useState(false);
  // Whether the escape element has been given its gesture-backed unlock play (see the
  // unlock effect). Recorded, not assumed: whether iOS actually requires it is
  // the open question, and a trace that says the escape's play() was rejected
  // on an element that WAS unlocked means something quite different from one
  // that says it was never unlocked at all.
  const escapeUnlockAttemptedRef = useRef(false);
  const escapeUnlockPlayedRef = useRef(false);
  // Detaches the "play again on the next gesture" listeners armed when the
  // escape's own play() is refused. Null whenever none are armed.
  const escapeRetryCleanupRef = useRef<(() => void) | null>(null);
  // A short ring of the keepalive's own routing/context transitions, attached
  // to the escape report. Without it, the report says the graph died but not
  // what it did on the way there.
  const keepaliveEventsRef = useRef<Array<Record<string, unknown>>>([]);
  // Filled in by `useLockDiagnostics` with its own ring-buffer push, so the
  // things only this file can see — above all WHY a play() was refused — land
  // in the trace IN ORDER, next to the media events around them. A separate
  // `reportFailure` line cannot be correlated with them after the fact; the
  // last diagnosis round lost a deploy cycle to exactly that.
  const noteRef = useRef<((what: string, extra?: Record<string, unknown>) => void) | null>(null);
  /** Record a refused play() with the reason the browser gave. */
  const noteRejection = useCallback((where: string, err: unknown) => {
    const name = err instanceof DOMException ? err.name : typeof err === 'object' && err && 'name' in err ? String((err as { name: unknown }).name) : 'unknown';
    noteRef.current?.(`playRejected:${where}`, { error: name });
  }, []);

  // The silent Web Audio keepalive (see silentKeepalive.ts) — one graph for
  // the whole session, lazily built. Building the handle itself has no side
  // effect (no `AudioContext` is created until `.start()` is first called),
  // so a plain lazy-ref-init is enough; no `useEffect`/`useMemo` needed.
  //
  // `onRoutingLost` is dispatched through a ref rather than wired directly,
  // because the handler it has to call (`escapeFromAudioGraph`) is declared
  // further down and needs this very handle. The ref is assigned on every
  // render, so by the time any callback can fire it holds today's closure.
  const escapeFromAudioGraphRef = useRef<(reason: string) => void>(() => {});
  const engineRef = useRef<ReturnType<typeof createMusicAudioEngine> | null>(null);
  if (!engineRef.current) {
    engineRef.current = createMusicAudioEngine({
      onRoutingLost: (reason) => escapeFromAudioGraphRef.current(reason),
      onEvent: (message, detail) => {
        keepaliveEventsRef.current.push({ at: Date.now(), message, ...detail });
        if (keepaliveEventsRef.current.length > KEEPALIVE_EVENT_LOG_MAX) {
          keepaliveEventsRef.current.shift();
        }
      },
    });
  }
  // Read live by `useLockDiagnostics` on every sample — see that hook's new
  // parameter for why this is a ref-wrapped function rather than a reactive
  // value.
  const keepaliveStateRef = useRef<() => KeepaliveContextState>(() => null);
  keepaliveStateRef.current = () => engineRef.current?.getState() ?? null;
  // Whether the ACTIVE element's audio currently leaves through the graph, and
  // whether the escape has already happened. Same live-read pattern.
  const routingRef = useRef<() => { routing: AudioRouting; escaped: boolean; mode: boolean }>(
    () => ({ routing: 'direct', escaped: false, mode: true }),
  );
  routingRef.current = () => ({
    routing: engineRef.current?.getRouting(audioRef.current) ?? 'direct',
    escaped: graphEscapedRef.current,
    // Which side of the experiment this sample belongs to. Without it, a
    // 'direct' reading is ambiguous — it could mean the switch is off, or that
    // a bind failed — and the whole point of the switch is comparing two
    // nights of traces against each other.
    mode: graphRoutingEnabled(),
  });

  // Whether the element has produced a confirmed `playing` event for the
  // CURRENT play attempt — distinct from `state.isPlaying`, which the reducer
  // sets to `true` at gesture time (the INTENT to play), before the browser
  // has actually resumed audio. Driving MediaSession off `state.isPlaying`
  // alone is exactly the reported lie: every measured 60-110s hang showed
  // `mediaSessionState: 'playing'` for its entire length, because that flag
  // flips the instant a gesture dispatches, never checking whether audio is
  // actually flowing. This becomes true only on the real `playing` event, and
  // false again the moment intent stops being backed by flowing audio.
  const [audioConfirmedPlaying, setAudioConfirmedPlaying] = useState(false);
  // Read live from effects that must not re-run when it changes.
  const audioConfirmedPlayingRef = useRef(false);
  audioConfirmedPlayingRef.current = audioConfirmedPlaying;
  // Bumped exactly when a rotation repoints `audioRef.current` at a
  // different physical element — see `useLockDiagnostics`'s docstring for why
  // this (and not an ordinary track change) is what should make it
  // resubscribe.
  const [audioIdentityKey, setAudioIdentityKey] = useState(0);
  // Bumped on a failed preload attempt (see the preload effect and
  // `handleError`'s non-active branch) to force that effect to re-run even
  // though the eligible next track (and therefore `nextSrc`) has not
  // changed — without this, clearing `preloadedUrlRef` on a preload error
  // has nothing that ever re-triggers the effect, so a track that failed to
  // preload would silently never get a second attempt until the queue
  // itself moved on.
  const [preloadRetryTick, setPreloadRetryTick] = useState(0);
  // How many times each URL has been allowed to fail a preload. MEASURED
  // NECESSITY, not defensive coding: the owner's phone logged 94 consecutive
  // `preloadError`s for ONE videoId, 1.2 seconds apart, for as long as the
  // track kept playing. `handleError` cleared the slot and bumped the retry
  // tick, the effect re-ran, the load failed again, and around it went — a
  // closed loop hammering the worker and eating the phone's connection, which
  // is the one resource this entire feature depends on. It is very likely why
  // playback went silent: the preload was starving it.
  //
  // Keyed by URL rather than by slot, because the slot rotates and the URL is
  // what actually failed. Cleared when a URL stops being adjacent, so a track
  // that failed an hour ago is retried freely when it comes round again.
  const preloadFailuresRef = useRef<Map<string, number>>(new Map());

  const currentIndex = currentIndexOf(state);
  const current = currentIndex >= 0 ? (state.queue[currentIndex] ?? null) : null;

  // The track immediately after `current` in play order — where autoplay
  // (NEXT / `advanceFromMediaEvent`) goes next. Drives the speculative
  // full-depth warm below, so it needs the same `order`/`pos` indirection
  // `currentIndexOf` uses rather than a plain `currentIndex + 1` (shuffle
  // means queue order and play order aren't the same thing).
  const nextIndex =
    state.pos >= 0 && state.pos + 1 < state.order.length ? state.order[state.pos + 1] : -1;
  const nextTrack = nextIndex >= 0 ? (state.queue[nextIndex] ?? null) : null;

  // The track immediately BEFORE `current` in play order — the other half of
  // the mixer's preload, and what makes "back" answer as fast as "next".
  // Same `order`/`pos` indirection as `nextIndex`: with shuffle on, queue
  // order and play order are not the same thing.
  //
  // Deliberately NOT mirrored into the server warm below — and the reason is
  // narrower than it first looks, so it is worth stating precisely rather than
  // as the tidy half-truth it started as ("prev is a track the listener just
  // heard, so the worker has it cached"). That is true of the common case and
  // FALSE in at least three reachable ones: `playNow` with a start index > 0,
  // `jumpTo`, and toggling shuffle all produce a `prev` nobody has played.
  //
  // It stays unwarmed anyway, on cost rather than on cache: the warm is a
  // speculative full download+transcode on a worker that has already fallen
  // over once under load, and stepping backwards is much rarer than letting a
  // queue run forwards. An un-warmed prev buffers over the slow path; a
  // worker that falls over costs everyone the fast one.
  const prevIndex = state.pos > 0 ? state.order[state.pos - 1] : -1;
  const prevTrack = prevIndex >= 0 ? (state.queue[prevIndex] ?? null) : null;

  const currentItemId = current?.itemId ?? null;
  // Read inside the error handler, which must not re-create on every track.
  const currentItemIdRef = useRef<string | null>(null);
  currentItemIdRef.current = currentItemId;
  // The track identity `useLockDiagnostics` stamps onto every sample. See that
  // hook's docstring for why this is a ref (read live) rather than a value in
  // its effect's dependency array.
  const lockDiagnosticsTrackRef = useRef<{ itemId: string | null; videoId: string | null }>({
    itemId: null,
    videoId: null,
  });
  lockDiagnosticsTrackRef.current = { itemId: currentItemId, videoId: current?.videoId ?? null };

  // Resolve a track's playable URL, or null when it can't be built. A preview
  // track carries its own `streamUrl` (the /bff/music/stream proxy for a
  // not-yet-downloaded videoId); a library track derives a Jellyfin DirectPlay
  // URL from its itemId + session. Shared by the imperative gesture path and the
  // declarative effect so both agree on what "already loaded" means.
  const trackSrc = useCallback(
    (track: MusicTrack | null): string | null => {
      if (!track) return null;
      if (track.streamUrl) return track.streamUrl;
      if (!track.itemId || !session?.jellyfinUserId || !session?.jellyfinToken) return null;
      return buildAudioStreamUrl(track.itemId, session.jellyfinUserId, session.jellyfinToken);
    },
    [session?.jellyfinUserId, session?.jellyfinToken],
  );

  // Swap which physical <audio> element is "active" and which is
  // "preloading": the element that has been silently buffering `url` while
  // the CURRENT track played becomes the one asked to play, instead of
  // assigning `url` onto the (about-to-be-abandoned) previously-active
  // element and forcing a brand-new network load on it. Buffered bytes live
  // on the specific HTMLMediaElement that fetched them — copying a `src`
  // string onto a different element does not carry them over — so this is
  // the only way "already preloaded" can mean anything. Never touches
  // `.src`/`.load()` on the promoted element: that would throw away the
  // entire point of having preloaded it. Returns false (and touches nothing)
  // if there is no preload element to promote.
  const applyOutputSettings = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // These stay on the ELEMENT rather than moving to the engine's role gains.
    // The gains are binary (this element is the one playing, or it is not);
    // the user's volume is a separate, continuous thing, and folding the two
    // into one number would make a rotation and a volume change
    // indistinguishable — and, per silentKeepalive's own measurement, would
    // double-apply the slider, which is applied upstream of the graph tap.
    audio.volume = stateRef.current.volume;
    audio.muted = stateRef.current.muted;
  }, []);

  // Put `url` on whatever element can actually make a sound, and report
  // whether anything changed.
  //
  // TWO WORLDS, and conflating them is a bug adversarial review caught with a
  // probe: normally the mixer owns this, and answers with a rotation. But
  // AFTER AN ESCAPE the three mixer slots are captive in a dead graph and the
  // engine deliberately answers 'unchanged' to everything — so a caller that
  // only asks the engine silently stops updating the track, and playback
  // sticks on whatever song was playing when the graph died. The escape
  // element is not the engine's to manage; it is this file's, and this is
  // where that ownership lives.
  const loadCurrentUrl = useCallback((url: string): boolean => {
    const engine = engineRef.current;
    if (!engine) return false;
    if (!engine.isEscaped()) return engine.setCurrentUrl(url) !== 'unchanged';
    // Escaped: drive the un-routed escape element directly. It is a single
    // element with no neighbour to rotate into, so this is the one place in
    // the file that still assigns `src` to the element that plays — which is
    // exactly the pre-mixer behaviour, and correct here because there is
    // nothing left to protect: the graph is already gone.
    const el = audioRef.current;
    if (!el || srcUrlRef.current === url) return false;
    el.src = url;
    el.load();
    return true;
  }, []);

  // Re-point `audioRef` at whatever the engine now calls "current", and tell
  // the diagnostics hook to move its listeners when the physical element
  // actually changed. Every engine call that can rotate roles ends with this.
  const syncActiveElement = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    // AFTER AN ESCAPE the active element is the escape one, which the engine
    // knows nothing about — its `current` is a mixer slot that is captive in a
    // dead graph and can never make a sound again. Re-pointing `audioRef` at
    // it would hand every subsequent track to a mute element, and since the
    // escape is one-way there would be no way back. Found by an adversarial
    // probe: the symptom was `ended` on the escape element advancing the queue
    // and then playing nothing at all.
    if (engine.isEscaped()) return;
    const next = engine.getCurrent();
    preloadAudioRef.current = engine.getElement('next');
    if (!next || next === audioRef.current) return;
    audioRef.current = next;
    setAudioIdentityKey((key) => key + 1);
  }, []);


  // Re-created every render so the timers below always run today's closures
  // (current track, latest `advanceFromMediaEvent`) even when armed on an
  // earlier render — the same ref-of-latest-closure technique `mediaActionsRef`
  // uses further down for the MediaSession action handlers. Assigned after
  // `advanceFromMediaEvent` is declared, below.
  const stallTimerRef = useRef<number | null>(null);
  // The track a pending watchdog fire is about. A fire whose key no longer
  // matches is stale — the user (or an earlier arm) already moved on from it
  // — and must be a no-op.
  const stallWatchdogKeyRef = useRef<string | null>(null);
  // 0 = watching the first attempt; 1 = already retried once via load()+play()
  // and now watching whether THAT attempt reaches `playing`.
  const stallRetryStageRef = useRef<0 | 1>(0);
  // When the pending watchdog was armed, so its firing can be checked against
  // real elapsed time — see `stallCheckRef` for the thawed-backlog case.
  const stallArmedAtRef = useRef(0);
  const stallCheckRef = useRef<(key: string | null, stage: 0 | 1) => void>(() => {});

  const clearStallWatchdog = useCallback(() => {
    if (stallTimerRef.current !== null) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  // Arms (or re-arms) the watchdog for the play attempt just made on `key`'s
  // track. Always restarts at stage 0 — a fresh `playImperative` call means a
  // fresh attempt, even if a previous one was mid-retry.
  const armStallWatchdog = useCallback((key: string | null) => {
    if (stallTimerRef.current !== null) window.clearTimeout(stallTimerRef.current);
    stallWatchdogKeyRef.current = key;
    stallRetryStageRef.current = 0;
    stallArmedAtRef.current = Date.now();
    stallTimerRef.current = window.setTimeout(() => {
      stallTimerRef.current = null;
      stallCheckRef.current(key, 0);
    }, STALL_WATCHDOG_MS);
  }, []);

  // Replay on the next real user interaction. The last resort shared by both
  // "iOS refused a programmatic play()" paths — a rotation that was blocked,
  // and the escape element taking over outside a gesture. Late, but it is the
  // difference between "the music came back when he touched the phone" and
  // "the music never came back". Held in a ref so unmount can detach it: a
  // leaked `{once}` listener still fires into a torn-down instance.
  const armGestureRetry = useCallback(() => {
    escapeRetryCleanupRef.current?.();
    const retry = () => {
      escapeRetryCleanupRef.current?.();
      const el = audioRef.current;
      if (!el || !stateRef.current.isPlaying) return;
      const again = el.play();
      if (again && typeof again.then === 'function') again.catch(() => {});
    };
    escapeRetryCleanupRef.current = () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('touchend', retry);
      document.removeEventListener('keydown', retry);
      escapeRetryCleanupRef.current = null;
    };
    document.addEventListener('pointerdown', retry, { once: true });
    document.addEventListener('touchend', retry, { once: true });
    document.addEventListener('keydown', retry, { once: true });
  }, []);

  // What happens when the element that just took over refuses to play.
  //
  // The old design answered this by swapping back to the element that had
  // received a real user gesture. The mixer has no such element: all three
  // slots are peers, each becomes `current` in turn, and rotating again would
  // hand the track to another slot with the same problem. So the answer moved
  // UPSTREAM — the unlock effect below now gives EVERY slot its own
  // gesture-backed silent play on the first interaction, which is the actual
  // fix if iOS's autoplay unlock turns out to be per-element.
  //
  // This is what is left for when that still fails: report it (whether it ever
  // fires on a real device is the one piece of evidence that would tell us the
  // per-element theory is true at all), and wait for a gesture. Deliberately
  // does NOT call `load()`: the slot is holding a fully buffered track, and
  // reloading would throw that away to fix something that is not about
  // buffering.
  const recoverFromRejectedRotation = useCallback(
    (target: MusicTrack | null, element: HTMLAudioElement) => {
      if (audioRef.current !== element) {
        // Stale: a later gesture or auto-advance already moved playback on.
        return;
      }
      reportFailure(
        'music.player.rotationPlayRejected',
        'rotated slot play() rejected; waiting for a gesture',
        { itemId: target?.itemId ?? null, videoId: target?.videoId ?? null },
      );
      // A rejected play() is not a stall, but the watchdog cannot tell the
      // difference — left armed it would fire load()+play() on a still-blocked
      // element, fail again, and then SKIP THE TRACK, walking silently through
      // the whole queue one track per minute. A blocked element needs a
      // gesture, not a retry.
      clearStallWatchdog();
      armGestureRetry();
    },
    [clearStallWatchdog, armGestureRetry],
  );


  // THE ESCAPE HATCH, and the reason the audio-graph feature is allowed to
  // ship at all.
  //
  // Routing the song into the keepalive's AudioContext buys one origin, and
  // costs this: if that context stops being able to make sound, the element
  // carrying the song is mute and CANNOT be repaired. There is no un-route
  // call, `disconnect()` only deepens the silence, and an element binds once
  // per document so a fresh context cannot take it back either (all three
  // verified against the spec, see silentKeepalive.ts). The only remaining
  // path to sound is a physically different element that was never routed.
  //
  // That is the escape element. This function moves playback onto it: same URL, same
  // position, same volume/mute, and it becomes `audioRef.current` so every
  // other part of this file — MediaSession, the stall watchdog, the seek
  // effect, the diagnostics — keeps working with no knowledge that anything
  // moved. Double buffering stops for the rest of the page load, because the
  // two elements it needs are the captive ones.
  //
  // One-way and at-most-once by construction: there is exactly one unrouted
  // element, so there is exactly one escape.
  //
  // WHAT THIS CANNOT PROMISE, said out loud rather than buried: the escape element's
  // `play()` here does NOT run inside a user gesture — the whole point is that
  // it fires while the screen is locked. Whether iOS honours it depends on
  // whether its autoplay unlock is per-element or per-document, which this
  // codebase has never been able to determine (the same open question
  // `recoverFromRejectedRotation` was written for). The unlock in the gesture
  // effect below is the mitigation; the `escapePlayRejected` report is what
  // will finally answer the question with evidence instead of reasoning.
  const escapeFromAudioGraph = useCallback(
    (reason: string) => {
      if (graphEscapedRef.current) return;
      graphEscapedRef.current = true;
      setGraphEscaped(true);
      const routed = audioRef.current;
      const preload = preloadAudioRef.current;
      const escape = escapeAudioRef.current;
      const url = srcUrlRef.current;
      const at = routed ? routed.currentTime : 0;
      const wantPlaying = stateRef.current.isPlaying;
      // Close the dead graph before anything else. Whatever it is doing now,
      // it is not carrying sound, and leaving an AudioContext alive next to
      // the element that is about to take over only gives WebKit a second
      // participant to weigh — the exact competition this design removed.
      // Out of service: the three slots are captive in a graph that cannot
      // sound, so the engine must stop rotating between them and stop
      // buffering into them. Marking BEFORE closing so nothing can slip a
      // rotation in between.
      engineRef.current?.markEscaped();
      engineRef.current?.close();
      reportFailure('music.player.audioGraphEscape', reason, {
        itemId: currentItemIdRef.current,
        at: Number(at.toFixed(2)),
        wantPlaying,
        hasEscapeElement: Boolean(escape),
        escapeUnlockAttempted: escapeUnlockAttemptedRef.current,
        escapeUnlockPlayed: escapeUnlockPlayedRef.current,
        hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        keepaliveEvents: keepaliveEventsRef.current.slice(-KEEPALIVE_EVENT_LOG_MAX),
      });
      // Deliberately NOT `if (!escape || !url) return`. Adversarial review
      // caught that pairing: with an escape element present but no `src` yet,
      // bailing left `audioRef.current` pointing at a captive element, so the
      // NEXT track would also load onto something that cannot sound. There is
      // only one case with nothing to do — no escape element at all — and it
      // cannot happen while the escape element is rendered unconditionally.
      if (!escape) return;
      // Both captive elements go quiet. The routed one is producing nothing
      // audible anyway, but it is still holding the media session as far as
      // the OS is concerned, and the preload one must stop buffering into a
      // future that is no longer coming.
      if (routed && !routed.paused) routed.pause();
      if (preload && !preload.paused) preload.pause();
      preloadedUrlRef.current = null;
      escape.volume = stateRef.current.volume;
      escape.muted = stateRef.current.muted;
      if (url) {
        escape.src = url;
        escape.load();
        // `currentTime` cannot be set before the element knows how long the
        // resource is; assigning it now is silently dropped. Restoring the
        // position matters more than usual here — this runs mid-song, so
        // without it the escape would restart the track from zero in the
        // listener's ear.
        //
        // It reads the position LIVE rather than replaying the value captured
        // above, because `loadedmetadata` can arrive an arbitrary time later
        // and the user may have moved in the meantime. A version that closed
        // over the escape-time position clobbered any seek made in that
        // window — including a lock-screen `seekto`, whose own effect ran
        // while the element still had no metadata and was therefore dropped.
        // `seekNonce` is what distinguishes the two: it changes only when
        // something actually asked to move.
        const nonceAtHandover = stateRef.current.seekNonce;
        const seekToHandover = () => {
          const target = stateRef.current.seekNonce === nonceAtHandover
            ? at
            : stateRef.current.position;
          if (!(target > 0)) return;
          try {
            escape.currentTime = target;
          } catch {
            // Not seekable (a live/chunked stream). Playing from the start
            // beats not playing.
          }
        };
        escape.addEventListener('loadedmetadata', seekToHandover, { once: true });
      } else {
        // Nothing was loaded to carry across; the declarative src effect owns
        // whatever comes next, and it now writes to the escape element.
        srcUrlRef.current = null;
      }
      audioRef.current = escape;
      // Same signal a promotion sends: the physical element behind
      // `audioRef.current` changed, so the diagnostics hook has to move its
      // listeners onto it.
      setAudioIdentityKey((key) => key + 1);
      if (!wantPlaying || !url) return;
      armStallWatchdog(currentItemIdRef.current);
      const p = escape.play();
      if (p && typeof p.then === 'function') {
        p.catch(() => {
          // iOS refused a programmatic play() on an element it does not
          // consider unlocked — the per-element theory being true. Report it
          // (this is the measurement), and take the only remaining shot:
          // replay on the next real user interaction. That is late, but it is
          // the difference between "the music came back when he touched the
          // phone" and "the music never came back".
          //
          // Disarming the stall watchdog is the other half, and adversarial
          // review is what surfaced it: a REJECTED play() is not a stall, but
          // the watchdog cannot tell the difference — 40s later it would fire
          // `load()`+`play()` on this same still-locked element, fail again,
          // and then SKIP THE TRACK. Left alone it would walk silently
          // through the whole queue, one track per minute, and report each
          // one as a stall. A blocked element needs a gesture, not a retry.
          clearStallWatchdog();
          reportFailure(
            'music.player.escapePlayRejected',
            'escape element play() rejected outside a gesture',
            {
              itemId: currentItemIdRef.current,
              escapeUnlockAttempted: escapeUnlockAttemptedRef.current,
              escapeUnlockPlayed: escapeUnlockPlayedRef.current,
            },
          );
          // Held in a ref so unmount can detach it. The sibling unlock effect
          // cleans its own listeners up and this one did not — an asymmetry
          // adversarial review flagged: after an unmount, a leaked `{once}`
          // listener still fires and reaches into a torn-down instance.
          const retry = () => {
            escapeRetryCleanupRef.current?.();
            const el = audioRef.current;
            if (!el || !stateRef.current.isPlaying) return;
            const again = el.play();
            if (again && typeof again.then === 'function') again.catch(() => {});
          };
          escapeRetryCleanupRef.current = () => {
            document.removeEventListener('pointerdown', retry);
            document.removeEventListener('touchend', retry);
            document.removeEventListener('keydown', retry);
            escapeRetryCleanupRef.current = null;
          };
          document.addEventListener('pointerdown', retry, { once: true });
          document.addEventListener('touchend', retry, { once: true });
          document.addEventListener('keydown', retry, { once: true });
        });
      }
    },
    [armStallWatchdog, clearStallWatchdog],
  );
  escapeFromAudioGraphRef.current = escapeFromAudioGraph;

  // Drive the element to play a target track SYNCHRONOUSLY, from inside a user
  // gesture. This is the iOS-critical path: play() must be called within the
  // same call stack as the click/touch, before React flushes any effect.
  const playImperative = useCallback(
    (target: MusicTrack | null) => {
      // FIRST THING IN THE GESTURE, before the URL is even resolved. This is
      // what buys the ability to lock the screen immediately: the OS gets a
      // playing media element now, instead of 5-10 seconds from now when the
      // track's bytes finally arrive.
      startTone();
      // And say so in the same breath. The listener asked for this in a
      // gesture; the control should not spend a render describing the state
      // they just left.
      publishPlaybackState(true);
      const engine = engineRef.current;
      if (!engine || !audioRef.current) return;
      const url = trackSrc(target);
      let rotated = false;
      // Only (re)assign src when the target actually differs from what's loaded;
      // re-assigning the same src would reset currentTime and stall playback.
      // THE TONE FIRST, and the order is the whole point. It is the floor the
      // session stands on: it has to already be sounding while the real track
      // is still loading, because that load is exactly the stretch with no
      // audio of its own, and no audio is what lets iOS freeze the tab.
      // Starting it afterwards puts the cushion in place after the fall. It
      // also decides who holds the audio route — WebKit hands that to whoever
      // asked LAST — so: silence first, song second.
      //
      // Synchronous and never awaited, so it cannot delay the play() below.
      // Every failure inside (no Web Audio, a rejected resume(), a refused
      // bind) is swallowed by the engine and can never reach this call stack.
      engine.resume();
      if (url) {
        // Hand the URL to the mixer. When a neighbour already holds it this is
        // a role rotation — no `src`, no `load()`, no gap — and the element
        // that WAS playing keeps its buffer as the new `prev`. A jump to a
        // track nobody buffered loads onto a NEIGHBOUR and rotates into it, so
        // even then the sounding element is never reassigned.
        if (loadCurrentUrl(url)) {
          // A gap of unknown length is about to open before the NEXT `playing`
          // event confirms real audio — never let a stale confirmation from
          // the PREVIOUS attempt keep MediaSession claiming 'playing' through
          // it.
          setAudioConfirmedPlaying(false);
          srcUrlRef.current = url;
          // Only a real rotation can be refused for per-element unlock
          // reasons; the escape element already had its own gesture.
          rotated = !engine.isEscaped();
          syncActiveElement();
          applyOutputSettings();
          // Seed the scale from what the source already told us. Without this
          // a streamed preview shows 0:00 and a full-looking bar until (or
          // unless) the element works the length out for itself.
          const known = target?.durationSeconds;
          if (typeof known === 'number' && Number.isFinite(known) && known > 0) {
            dispatch({ type: 'SET_DURATION', duration: known });
          }
        }
      }
      const audio = audioRef.current;
      if (!audio) return;
      // NOTHING PLAYABLE — stop, do not play whatever is still loaded.
      //
      // A regression this rewrite introduced and an adversarial probe caught:
      // the old declarative effect cleared the element's src when the track
      // had no resolvable URL, so there was nothing left to sound. The mixer
      // deliberately keeps the stale source (an element with no src cannot be
      // routed, and losing graph membership over an unplayable track is a bad
      // trade) — which means the guard has to move HERE instead. Without it,
      // `play()` runs on the previous track's buffer: the listener hears the
      // song they just heard while the UI shows a different one.
      if (!url) {
        pauseIntentionally(audio);
        return;
      }
      armStallWatchdog(target?.itemId ?? null);
      const p = audio.play();
      // ONLY NOW do the neighbours go quiet. The outgoing element was left
      // playing through the rotation on purpose, so this `play()` lands before
      // anything has stopped; pausing first would open a real gap between the
      // pause and the start.
      //
      // What the outgoing element is doing in between depends on the routing
      // mode, and the honest version of that is worth stating: WITH routing
      // on, its role gain went to zero at the rotation, so it has been
      // inaudible since. WITHOUT routing there are no gain nodes at all and
      // `setGain` is a no-op, so it is briefly still audible — but only until
      // the call below, which runs synchronously in this same tick, a few
      // microseconds later. Not a seam anyone can hear, and not what an
      // earlier version of this comment claimed.
      engine.silenceNeighbours();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          unlockedRef.current = true;
        }).catch((err: unknown) => {
          // A slot rotated into may never have received a user gesture of its
          // own — if iOS's autoplay unlock is per-element rather than
          // per-document, its play() rejects here, silently. See
          // `recoverFromRejectedRotation` for what happens then.
          //
          // AbortError is filtered out here on purpose — verified by a
          // second adversarial pass to be reachable in practice, not just in
          // theory: the stall watchdog's own stage-0 retry (`audio.load()`,
          // see below) on THIS SAME element aborts whatever play() is still
          // pending on it, including this very promoted attempt, with
          // `AbortError`. That is this file interrupting itself, not iOS
          // refusing anything — treating it as a real block would both log
          // false "promotionPlayRejected" evidence (poisoning the one signal
          // this mitigation exists to collect) AND run the fallback for no
          // reason while the watchdog's own retry is still in flight,
          // stepping on it. A genuine autoplay rejection (NotAllowedError,
          // etc.) is never reported as AbortError, so nothing real is lost by
          // skipping it here.
          noteRejection(rotated ? 'rotation' : 'same-slot', err);
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (!isAbort && rotated) {
            recoverFromRejectedRotation(target, audio);
          }
          // BEFORE THE FIRST SUCCESSFUL PLAY OF THE SESSION a rejection means
          // the element is genuinely still locked, and the UI must not claim
          // to be playing. This reader was lost when the declarative effect
          // stopped calling `play()` itself: `unlockedRef` kept being written
          // and nothing read it any more, so a refused first play left the
          // transport showing "playing" forever — the exact class of lie the
          // rest of this file exists to prevent. It belongs here now, on the
          // one path that starts all playback. After that first success the
          // old rule stands unchanged: a transient rejection must not flip a
          // gesture-initiated play to paused.
          if (!isAbort && !unlockedRef.current) {
            dispatch({ type: 'SET_PLAYING', value: false });
          }
          // Gesture-initiated: don't flip to paused. If the element is still
          // locked the belt-and-suspenders unlock listener handles it; once
          // unlocked, transient rejections must not lie about play state.
        });
      }
    },
    [
      trackSrc,
      armStallWatchdog,
      loadCurrentUrl,
      syncActiveElement,
      applyOutputSettings,
      recoverFromRejectedRotation,
      noteRejection,
      startTone,
      publishPlaybackState,
      pauseIntentionally,
    ],
  );

  // Latest `advanceFromMediaEvent`, for callers declared before it.
  const advanceFromMediaEventRef = useRef<() => void>(() => {});

  // Latest `playImperative`, reachable from effects that must not list it as
  // a dependency (see the play/pause effect below for why).
  const playImperativeRef = useRef(playImperative);
  playImperativeRef.current = playImperative;

  // Run a reducer action that (may) start/resume playback from a user gesture:
  // compute the resulting target synchronously and drive the element FIRST,
  // then dispatch so the UI catches up. Resolving the target through the pure
  // reducer means next/prev/jump/shuffle logic never has to be duplicated here.
  const runGesture = useCallback(
    (action: Action) => {
      const nextState = reducer(stateRef.current, action);
      if (nextState.isPlaying) {
        const idx = currentIndexOf(nextState);
        const target = idx >= 0 ? (nextState.queue[idx] ?? null) : null;
        playImperative(target);
      }
      dispatch(action);
    },
    [playImperative],
  );

  // Auto-advance when the element itself says the track is over (`ended`, or a
  // dead source via `onError`).
  //
  // This must drive the element from inside the media event's own task, exactly
  // like a tap does. Dispatching alone leaves the actual play() to a passive
  // effect, and React schedules those through the scheduler — a MessageChannel
  // callback. With the screen locked, WebKit suspends the page hard: an on-device
  // probe measured 84s frozen with no audio playing, against 3s of throttling
  // while audio was. The dispatch lands, the effect never runs, and playback
  // simply stops between tracks. Calling play() here instead is the same shape
  // the click path already uses, and the probe confirmed iOS allows it from a
  // media handler on a locked phone — including a cold network fetch.
  //
  // Repeat-one is deliberately left on the dispatch path: it reuses the current
  // source, so playing synchronously would resume at the very end of the track
  // and risk firing `ended` again before the seek-to-zero effect lands. It
  // already works, and it is not what the owner reported.
  //
  // REPEAT-ONE USED TO BE LEFT ON THE DISPATCH PATH, on the reasoning that it
  // reuses the current source, so replaying synchronously would resume at the
  // very end of the track and risk re-firing `ended` before the seek-to-zero
  // effect landed. That reasoning was about event ordering, and it ignored
  // that the dispatch path is exactly the one a frozen tab never runs: a
  // repeat-one track on a locked phone stopped dead at the end of its first
  // play. The reported bug, in its purest form.
  //
  // Rewinding BEFORE the play() answers the ordering concern directly — an
  // element at position 0 cannot fire `ended` — instead of deferring the work
  // to a scheduler callback that may never come.
  const advanceFromMediaEvent = useCallback(() => {
    const action: Action = { type: 'NEXT', auto: true };
    if (stateRef.current.repeat === 'one') {
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.currentTime = 0;
        } catch {
          // Not seekable — play() on an ended element restarts it anyway.
        }
        // Re-arm the watchdog: `handleEnded` cleared it, this branch does not
        // go through `playImperative` (the only other place that arms it), and
        // the effect that would re-arm is keyed on `[isPlaying, currentItemId]`
        // — neither of which changes on a loop. Without this, repeat-one is the
        // ONE path with no detection for "play() was called and `playing` never
        // arrived", on the very path this rewrite just made synchronous in
        // order to survive a locked screen.
        armStallWatchdog(currentItemIdRef.current);
        const p = audio.play();
        if (p && typeof p.then === 'function') {
          p.catch((err: unknown) => {
            noteRejection('repeat-one', err);
            // Same rules as every other rejection path here: only correct the
            // UI before the first successful play, and give a refused element
            // a gesture to come back on rather than letting the watchdog spend
            // 40s and then skip the track.
            if (!unlockedRef.current) dispatch({ type: 'SET_PLAYING', value: false });
            clearStallWatchdog();
            armGestureRetry();
          });
        }
      }
      dispatch(action);
      return;
    }
    runGesture(action);
  }, [runGesture, armStallWatchdog, clearStallWatchdog, armGestureRetry, noteRejection]);
  advanceFromMediaEventRef.current = advanceFromMediaEvent;

  // The watchdog's actual check, run from the timers `armStallWatchdog` sets
  // up. Reassigned every render (not a useCallback) purely so it always
  // closes over today's `current`/`advanceFromMediaEvent` — the timer that
  // invokes it is armed once but may fire many renders later.
  stallCheckRef.current = (key, stage) => {
    if (stallWatchdogKeyRef.current !== key || stallRetryStageRef.current !== stage) return;
    const audio = audioRef.current;
    if (!audio) return;
    // A TIMER THAT FIRED LATE IS NOT EVIDENCE OF A STALL.
    //
    // Measured: all four of the owner's watchdog reports landed inside the
    // SAME SECOND, two of them "skipping track", for two different tracks. He
    // was not watching four stalls — he had picked the phone up, and iOS
    // released every timer it had frozen at once. The watchdog read that
    // backlog as proof that nothing was playing and walked the queue forward,
    // so coming back to the app moved his music on by itself.
    //
    // A timer that took far longer than it was set for has learned nothing
    // about the element: the tab was suspended for most of that window, which
    // is precisely when playback cannot be judged. Re-arm and give this track
    // a fair, awake window instead of spending its budget on frozen time.
    const armedFor = stage === 0 ? STALL_WATCHDOG_MS : STALL_RETRY_GRACE_MS;
    const elapsed = Date.now() - stallArmedAtRef.current;
    const overdue = elapsed > armedFor * STALL_TIMER_LATE_RATIO;
    if (overdue || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      noteRef.current?.('watchdogDeferred', { elapsed, armedFor, stage });
      armStallWatchdog(key);
      return;
    }
    // No `readyState`/`paused` re-check here on purpose — adversarial review
    // caught an earlier version that had one (`readyState > 1` treated as
    // "not stalled"), and it was actively wrong for exactly the scenario
    // double buffering is meant to help: a PROMOTED element can legitimately
    // already be at `readyState` 4 (fully preloaded) while still never
    // having produced a `playing` event, if its `play()` was silently
    // rejected — `readyState > 1` would have waved that through as healthy.
    // The only fact this callback needs is the one thing that is guaranteed:
    // `handlePlaying` calls `clearStallWatchdog()` synchronously and
    // `clearTimeout` is unconditional in single-threaded JS, so if this
    // callback is running AT ALL, `playing` has not fired for this attempt —
    // full stop, nothing left to double-check. `handlePause`,`handleEnded`,
    // and `handleError`'s active branch clear it the same way for their own
    // terminal outcomes, so a genuine user pause or a track that already
    // ended/errored can't reach here either.
    if (stage === 0) {
      stallRetryStageRef.current = 1;
      reportFailure('music.player.stallWatchdog', 'no playing event before timeout; retrying', {
        itemId: key,
        videoId: current?.videoId ?? null,
        readyState: audio.readyState,
        bufferedEnd: timeRangeEnd(audio.buffered),
      });
      audio.load();
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      // Restart the clock for stage 1: the lateness check below measures each
      // stage against its OWN window, and carrying stage 0's start forward
      // made every stage-1 firing look like a thawed backlog.
      stallArmedAtRef.current = Date.now();
      stallTimerRef.current = window.setTimeout(() => {
        stallTimerRef.current = null;
        stallCheckRef.current(key, 1);
      }, STALL_RETRY_GRACE_MS);
      return;
    }

    // Second trip: even a fresh load()+play() never produced `playing` within
    // the shorter grace window. There is no evidence a third attempt would
    // behave differently — none of the measured hangs recovered on their own
    // even after 60-110s — so skip forward instead of sitting in more
    // silence.
    stallRetryStageRef.current = 0;
    reportFailure('music.player.stallWatchdog', 'retry also stalled; skipping track', {
      itemId: key,
      videoId: current?.videoId ?? null,
      readyState: audio.readyState,
      bufferedEnd: timeRangeEnd(audio.buffered),
    });
    consecutiveErrorsRef.current += 1;
    // Same breaker `onError` uses: skipping past one dead track is right,
    // sprinting through a whole queue because the network is truly gone is
    // not.
    if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_AUDIO_ERRORS) {
      dispatch({ type: 'SET_PLAYING', value: false });
      return;
    }
    advanceFromMediaEvent();
  };

  // The URL the current track resolves to (preview streamUrl or Jellyfin). Used
  // as the src-effect key so re-renders that don't change the source never
  // reload/restart playback.
  const currentSrc = trackSrc(current);

  // Point the mixer at the current track for transitions that never went
  // through a gesture — a track removed from the queue, a jump made while
  // paused, a restored session.
  //
  // THIS EFFECT USED TO ASSIGN `audio.src` ITSELF, which made it a THIRD path
  // writing to the element that was sounding — the exact `emptied` -> `load`
  // -> `play` gap the mixer exists to remove, hiding behind a name that reads
  // like bookkeeping. Found while re-reading the diff, after the two obvious
  // engines had already been dealt with.
  //
  // It now asks the engine instead, which is free to answer with a rotation
  // (no load at all) and, when it really must load, does so onto a neighbour
  // slot rather than the one making sound. Everything else this effect owns —
  // resetting the per-track diagnostic latches, dropping a stale `playing`
  // confirmation — is unchanged.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !audioRef.current) return;
    if (!currentSrc) {
      // Deliberately does NOT clear the slot's source. An element with no src
      // cannot be routed and cannot sound, so a queue passing through a track
      // with no resolvable URL must not cost the session its graph membership.
      // The stale source is harmless; the next real track replaces it.
      srcUrlRef.current = null;
      durationReportedRef.current = null;
      pastKnownDurationRef.current = null;
      setAudioConfirmedPlaying(false);
      return;
    }
    if (srcUrlRef.current === currentSrc) return; // already loaded (e.g. by the gesture)
    durationReportedRef.current = null;
    pastKnownDurationRef.current = null;
    setAudioConfirmedPlaying(false);
    if (loadCurrentUrl(currentSrc)) {
      srcUrlRef.current = currentSrc;
      syncActiveElement();
      applyOutputSettings();
    }
    // `isPlaying` is intentionally not a dep — the play/pause effect below owns it.
  }, [currentSrc, loadCurrentUrl, syncActiveElement, applyOutputSettings]);

  // Warm the worker's cache for the *next* queue track at full depth
  // (download + ffmpeg, not just the URL resolve) the moment the current
  // track is actually playing — it eliminates the gap between songs that a
  // 'url'-only warm can't (see `warmMusicTrack`'s docstring for the depth
  // tradeoff). Restricted to a track that isn't in the library yet (it has a
  // `streamUrl`): a downloaded track plays straight from Jellyfin and never
  // touches the worker at all, so warming it would be a no-op request. Only
  // ever one track ahead — the production worker has already fallen over
  // once under load, and this is speculative work for a track that hasn't
  // been requested yet.
  useEffect(() => {
    if (!state.isPlaying) return;
    if (!nextTrack?.videoId || !nextTrack.streamUrl) return;
    // The queue never learned which surface this preview's videoId came
    // from — only its already-built stream URL. But that URL isn't source-
    // blind: `previewStreamUrl` embeds the real source as its own `source`
    // query param, and `streamUrlSource` reads it back out. Sending the
    // actual source (rather than always 'auto') matters because the
    // worker's resolved-URL cache (`_stream_cache`) is keyed on videoId
    // alone — a warm that lies about the source can seed that cache via the
    // wrong branch, and the real play would then silently reuse the wrong
    // answer instead of resolving its own.
    warmMusicTrack(nextTrack.videoId, streamUrlSource(nextTrack.streamUrl), 'full');
  }, [state.isPlaying, nextTrack?.videoId, nextTrack?.streamUrl]);

  // The URL the immediately-next queue track resolves to, but ONLY while the
  // current one is playing, and only for a track that isn't in the library
  // yet (has a `streamUrl`) — the same population the full-depth server warm
  // above targets. Computed here (not inside the effect) so the effect's own
  // dependency array can be this one string, the same pattern `currentSrc`
  // above already uses.
  //
  // Gating on `state.isPlaying` is a deliberate, explicit tradeoff, not an
  // oversight: a pause — including an involuntary one, e.g. iOS handing audio
  // focus to a phone call — drops `nextSrc` to `null`, and the preload effect
  // below then discards whatever had been buffered and calls `load()` again
  // on resume, paying a fresh fetch for the one transition right after an
  // interruption.
  //
  // THAT TRADEOFF NOW COSTS DOUBLE, and it is recorded here because nobody
  // measured it: with a `prev` slot as well, a pause discards TWO buffers
  // instead of one, and in steady state there are two speculative GETs
  // competing with the track that is actually sounding — on the connection
  // this whole feature calls its scarcest resource. Adversarial review
  // flagged it and it is a fair flag: the second direction was added because
  // the owner asked for instant back, not because anything showed the network
  // could carry it. If on-device traces ever show preloading competing with
  // playback, dropping `prevSrc` is the first thing to try. The alternative (keep buffering through a pause) would
  // violate the one constraint this whole feature is built on — network
  // access is only reliable while a track is actively playing — for a case
  // (pause during exactly the wrong few seconds) with no on-device evidence
  // either way.
  // `graphEscaped` (the React state, not the ref) is what makes this a real
  // dependency: after the handover the preload element is one of the two
  // captive ones, so buffering into it would spend the session's scarce
  // background network on bytes that can never be played. Dropping to null
  // also drives the preload effect's own cleanup branch, which releases the
  // resource it is still holding.
  const nextSrc =
    !graphEscaped && state.isPlaying && nextTrack?.streamUrl ? trackSrc(nextTrack) : null;
  // The track behind the current one, buffered on exactly the same terms. The
  // owner asked for both directions to answer immediately, and a step back
  // that pays a full fetch is the same dead air as a step forward that does.
  const prevSrc =
    !graphEscaped && state.isPlaying && prevTrack?.streamUrl ? trackSrc(prevTrack) : null;

  // Preload the NEXT track into the SEPARATE, hidden preload <audio> element
  // while the CURRENT one is still playing — the only point in the lifecycle
  // where iOS reliably grants this tab any meaningful network access at all.
  //
  // The measurement this is built on: 21 on-device auto-advances with the
  // phone locked (iPhone, iOS 18.7 Safari), 10 succeeded and 11 hung for
  // 60-110s with the identical shape (`waiting` -> `stalled` -> total
  // silence, `readyState` stuck at 0-1, no further event of any kind). Three
  // server-log cross-checks cleared the backend: one hang's file finished on
  // the worker 9.84s in while the phone's connection sat stalled 112s until
  // Caddy reset it; one hang had NO server-side activity at all — the track
  // was never even requested; one hang's file was ready on the worker 12s
  // BEFORE `play()` and it still hung 89s. In all three, the bottleneck was
  // the phone failing to open/use a connection, not the server being slow.
  //
  // `020406d`'s on-device probe found that iOS "will start a PRELOADED track
  // from an `ended` handler" — preloaded is the word doing the work, and in
  // the mixer it is the ONLY word: a rotation cannot start a track that was
  // not already buffered, because it never issues a load.
  //
  // NOT a fix, and not claimed as one: this raises the odds, it does not
  // guarantee them. None of the three cross-checked hangs above were caused
  // by anything the client had or hadn't buffered — iOS can freeze the tab's
  // network at any point regardless of what's already loaded. A client-side
  // buffer only helps the transitions where the freeze happens to land after
  // the buffer was filled.
  //
  // Restricted to `streamUrl` tracks (same criterion as the full-depth server
  // warm above): a downloaded library track plays straight off Jellyfin
  // DirectPlay, which appears to track playback/session state per request on
  // the server; opening a second concurrent GET against the same item purely
  // to prebuffer risks confusing that bookkeeping for a payoff this slice has
  // no on-device evidence for, so it is left alone for now. Only ever one
  // track ahead — the production worker has already fallen over once under
  // load, and this is speculative work for a track that hasn't been
  // requested yet.
  useEffect(() => {
    // Forget the tally for anything that is no longer adjacent, so the budget
    // is per-approach rather than per-session.
    const live = new Set([nextSrc, prevSrc].filter((u): u is string => Boolean(u)));
    for (const url of preloadFailuresRef.current.keys()) {
      if (!live.has(url)) preloadFailuresRef.current.delete(url);
    }
    const affordable = (url: string | null) =>
      url && (preloadFailuresRef.current.get(url) ?? 0) < MAX_PRELOAD_FAILURES ? url : null;
    engineRef.current?.setNeighbourUrls({
      next: affordable(nextSrc),
      prev: affordable(prevSrc),
    });
  }, [nextSrc, prevSrc, preloadRetryTick]);


  // Reflect the isPlaying flag onto the element. A rejected play() while the
  // element is still locked (autoplay policy, no src) flips the flag back so the
  // UI stays truthful — but only before the first successful play; afterwards
  // the element is unlocked and transient rejections must not lie.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItemId) return;
    if (state.isPlaying) {
      // THE SECOND ENGINE IS GONE, and that is the point of this rewrite. This
      // effect used to call `audio.play()` itself, which made it a rival
      // driver to `playImperative`: two paths starting playback, disagreeing
      // about which element and which URL, and — critically — one of them
      // living behind React's scheduler. Every transition that did not go
      // through a gesture depended on THIS effect alone, and a tab iOS has
      // frozen may never run a scheduler callback. The dispatch landed; the
      // sound did not.
      //
      // Now it delegates to the one engine instead of being a second one. On a
      // path that already went through `runGesture` this re-runs idempotently
      // (same URL -> 'unchanged', no rotation, play() on an already-playing
      // element is a no-op).
      const idx = currentIndexOf(stateRef.current);
      playImperativeRef.current(idx >= 0 ? (stateRef.current.queue[idx] ?? null) : null);
    } else {
      pauseIntentionally(audio);
    }
    // `playImperative` is reached through a ref so this effect keeps firing on
    // exactly the two values that describe "what should be playing" — adding
    // it as a dependency would re-run everything on every render that rebuilt
    // the callback, re-arming the stall watchdog each time.
  }, [state.isPlaying, currentItemId, pauseIntentionally]);

  // Keep the stall watchdog's lifecycle tied to the SAME ground truth as the
  // effect above (`state.isPlaying` + `currentItemId`), not just to
  // `playImperative`'s call sites. Adversarial review found `armStallWatchdog`
  // was ONLY ever invoked from `playImperative` — so any transition that
  // changes what should be playing WITHOUT going through it left a stale
  // watchdog running:
  //
  //  - Emptying the queue (`removeFromQueue` down to nothing) dispatches
  //    `REMOVE` directly; nothing ever paused the element or cleared the
  //    timer, so a watchdog armed for the just-removed track fired anyway —
  //    `load()`+`play()` on a src-less element, a false report, and a
  //    consecutive-error charged against nothing.
  //  - Removing the CURRENT track while others remain reassigns `current` to
  //    whatever shifted into its slot WITHOUT changing `isPlaying` (see the
  //    `REMOVE` reducer branch) and without calling `playImperative` either —
  //    so the OLD watchdog (armed for the removed track, on whatever timeout
  //    had already elapsed) kept counting down and fired against the NEW
  //    current track: wrong `itemId` in the report, and a timeout budget with
  //    no relationship to when the new track actually started loading.
  //
  // Keying this off the same two reactive values the declarative play/pause
  // effect already trusts fixes both: any `currentItemId` change re-arms
  // fresh (correct track, full budget), and `isPlaying` turning false (paused
  // by the user OR the queue running out) clears it — the latter also closes
  // a related gap in `handlePause` alone: a `pause()` call on an element
  // whose `paused` was already `true` (e.g. after a play() that silently
  // never started) produces NO `pause` event at all per spec, so a handler
  // keyed only on that event can miss a user's own pause entirely. `dispatch`
  // updating `state.isPlaying` is unconditional and synchronous regardless of
  // what the DOM element does, so this effect cannot miss it the same way.
  useEffect(() => {
    if (!state.isPlaying || !currentItemId) {
      clearStallWatchdog();
      return;
    }
    armStallWatchdog(currentItemId);
  }, [state.isPlaying, currentItemId, clearStallWatchdog, armStallWatchdog]);

  // Stop side of the silent keepalive's lifecycle (the start side lives in
  // `playImperative`, gesture-synchronous). Keyed on `state.isPlaying` alone,
  // the same ground truth `visibleBuffering`/the effect above trust: it goes
  // false on a real user pause, on the consecutive-error breaker tripping,
  // AND on the queue simply running out (`NEXT`'s "end of the play order, no
  // repeat" branch and `REMOVE`'s "queue emptied" branch both set it — see
  // musicPlayerCore.ts's reducer), so this one effect covers "the user
  // paused" and "the queue ended" without needing to special-case either.
  // `suspend()` (not `close()`) on purpose: REQUIREMENT 1 is "not left
  // running forever for no reason", not "torn down" — keeping the graph
  // intact means a later resume needs no fresh construction, and the
  // multiple-pause/resume-cycles test below asserts exactly that no second
  // context ever gets built.
  useEffect(() => {
    engineRef.current?.setPlaybackIntent(state.isPlaying);
  }, [state.isPlaying]);

  // Belt-and-suspenders: unlock the media element on the very first user
  // interaction anywhere in the document. If a track is loaded but paused, a
  // guarded no-op play()->pause() satisfies iOS's user-activation requirement
  // so a later programmatic play() (e.g. auto-advance on `ended`) is allowed.
  // Safe when nothing is loaded — it does nothing. Fires at most once.
  //
  // ONLY the ACTIVE element is probed here. An earlier version also probed
  // the PRELOAD element (muted) inside this same gesture, as PREVENTION
  // against iOS possibly scoping its autoplay unlock per-element. It was
  // removed, and must not come back in that shape:
  //
  //   - It was the only place in this file where TWO <audio> elements could
  //     be calling `play()` at the same time. Every other `play()` call site
  //     targets `audioRef.current`; ordinary preloading only ever assigns
  //     `src` + `load()`, and a rotation never plays at all.
  //   - WebKit hands the single audio focus a page gets to whichever element
  //     called `play()` MOST RECENTLY — and the muted preload probe ran
  //     AFTER the real element's play(), i.e. last. The old comment here
  //     already flagged that ordering as unproven; the owner's iPhone then
  //     reported the matching symptom directly: "it says it is playing but
  //     there is no sound", with the position advancing and `paused: false`.
  //     That is exactly what losing audio focus to a muted sibling looks
  //     like.
  //
  // Removing it reopens the risk it was written for: if iOS's unlock really
  // is per-element, a promoted preload element's first `play()` is rejected
  // because that element never received a gesture of its own. That case is
  // covered by `recoverFromRejectedRotation` instead, which reports
  // `music.player.rotationPlayRejected` — the only evidence that would tell us
  // the per-element theory is true at all — and replays on the next touch. It
  // is the only net under that risk, so it must stay intact.
  useEffect(() => {
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
      document.removeEventListener('keydown', unlock);
      // FIRST, before the active element is touched at all — and the order is
      // the entire safety argument, so it must not be moved.
      //
      // The probe removed in `92b215f` played a SECOND element inside this
      // same gesture and the owner's iPhone reported "it says it is playing
      // but there is no sound". The mechanism that explains it is WebKit
      // handing the single audio route to whoever called `play()` MOST
      // RECENTLY, and that probe ran last: after the real element's play().
      // This one runs first, on a `pointerdown` that precedes the `click`
      // which starts the song, so every later `play()` — the active
      // element's probe below, and the song itself in `playImperative` — is
      // more recent than this. It is also 50ms of silence that ENDS on its
      // own (no pause() racing anything) and needs no network, so it is over
      // before a real track has finished loading.
      //
      // What it buys: the escape element has then played once from a user gesture, which
      // is what iOS requires per element IF its unlock is per-element. If it
      // is per-document instead, this is harmless dead weight. Nobody has
      // been able to determine which — so this is written to be safe under
      // both readings rather than correct under one.
      // UNLOCK EVERY SLOT — and this reverses a call made earlier in this same
      // rewrite, because the device data came back and settled it.
      //
      // The reasoning for NOT doing it was that these plays could land after a
      // real one and take the audio route (92b215f: "it says it is playing but
      // there is no sound"). That risk is real, so it is fenced rather than
      // accepted: this only runs when NOTHING is sounding. With the active
      // element paused there is no route to steal, and the probe below — which
      // targets the active element and runs last — still asks most recently.
      //
      // What changed is the other side of the trade, which is no longer a
      // guess. From the owner's phone, on the previous build:
      //   - `music.player.rotationPlayRejected` fired: iOS refused the rotated
      //     slot's play(). The per-element unlock theory is no longer a theory.
      //   - The traces show the element sitting at `t: 0`, `ready: 4`,
      //     `paused: true` — fully buffered and never started. Not audio that
      //     stopped: audio that was never allowed to begin.
      // That is the reported silence, and leaving two of three rotating slots
      // without a gesture is what causes it. A fenced risk beats a measured
      // failure.
      const clip = silentAudioClip();
      if (clip && !escapeUnlockAttemptedRef.current) {
        escapeUnlockAttemptedRef.current = true;
        const escape = escapeAudioRef.current;
        const active = audioRef.current;
        // "Nothing is sounding" checked against the ELEMENT, not just intent:
        // `isPlaying` records what we asked for, and this whole bug is about
        // those two disagreeing.
        const quiet = !stateRef.current.isPlaying && (!active || active.paused);
        const targets = quiet ? [escape, ...engineSlotsRef.current] : [escape];
        for (const el of targets) {
          if (!el) continue;
          // Never clobber a slot that is holding something — the silent clip
          // would overwrite a buffered (or sounding) track with 50ms of
          // nothing. The active element is skipped for the same reason and one
          // more: it has its own probe below, with a suppression window so its
          // play/pause events are not mistaken for the user's.
          if (el === active) continue;
          if (el !== escape && (el.currentSrc || el.getAttribute('src'))) continue;
          try {
            el.src = clip;
            const ep = el.play();
            if (ep && typeof ep.then === 'function') {
              ep.then(() => {
                if (el === escape) {
                  escapeUnlockPlayedRef.current = true;
                  return;
                }
                // HAND THE SLOT BACK. The clip has done its only job — this
                // element has now played from a user gesture — and leaving it
                // loaded makes the slot look occupied to everything that
                // inspects it, including a human reading the DOM while
                // debugging. Released here rather than before `play()`
                // resolves, because clearing the source mid-play cancels the
                // very unlock this is for.
                //
                // The escape element is exempt: it deliberately keeps the clip
                // as its resting state until the day it has to take over.
                try {
                  el.pause();
                  el.removeAttribute('src');
                  el.load();
                } catch {
                  // A slot that could not be cleared is still unlocked, which
                  // was the point; the engine overwrites the source anyway.
                }
              }).catch(() => {
                // Refused. Each element can still try again from its own
                // rejection path; nothing here is worth reporting alone.
              });
            }
          } catch {
            // Never let unlocking break the gesture about to start the music.
          }
        }
      }
      const audio = audioRef.current;
      if (audio) {
        unlockedRef.current = true;
        if (srcUrlRef.current && !stateRef.current.isPlaying) {
          // Open the suppression window synchronously, BEFORE play() — its
          // resulting `play`/`pause` events must be swallowed by the handlers
          // below, not observed as a real user play/pause.
          probeRef.current = true;
          const p = audio.play();
          if (p && typeof p.then === 'function') {
            p.then(() => {
              if (stateRef.current.isPlaying) {
                // The user won the race with a real play in the meantime —
                // nothing to suppress, and pausing now would be a real pause.
                probeRef.current = false;
                return;
              }
              audio.pause(); // its `pause` event closes the window (see onPause)
            }).catch(() => {
              probeRef.current = false;
            });
          } else {
            probeRef.current = false;
          }
          // Belt-and-suspenders: if the probe's play() never settles, don't
          // deadlock reconciliation forever. A leaked probe-pause after this is
          // harmless — the probe only runs when `!isPlaying`, so the dispatch
          // it would have made is an identity-return no-op anyway.
          window.setTimeout(() => {
            probeRef.current = false;
          }, 3000);
        }
      }
    };
    // `keydown` is here for the escape element's sake, not the active one's:
    // adversarial review pointed out that a control activated from the
    // keyboard (Enter/Space) dispatches no pointer or touch event at all, so
    // a keyboard-only session would start music with the escape element never having
    // played — and the escape element only matters when it is asked to take over without
    // a gesture of its own. `keydown` precedes the resulting `click` the same
    // way `pointerdown` does, so the ordering argument above holds unchanged.
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('touchend', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  // The settle timer and the stall watchdog both live in refs (armed/cleared
  // from event handlers, not effects) so both must be cleared explicitly on
  // unmount too. The keepalive's `AudioContext` (if one was ever built) is
  // torn down here too — REQUIREMENT 1's "not left running forever" endpoint:
  // `suspend()` (the pause-lifecycle effect above) keeps it around for a
  // later resume, but the provider going away for good has no later resume to
  // wait for, so this is the one place that actually calls `close()`.
  useEffect(() => {
    return () => {
      if (bufferingTimerRef.current !== null) {
        window.clearTimeout(bufferingTimerRef.current);
      }
      if (stallTimerRef.current !== null) {
        window.clearTimeout(stallTimerRef.current);
      }
      escapeRetryCleanupRef.current?.();
      engineRef.current?.close();
    };
  }, []);

  // Arms the settle window on a `waiting`/`stalled` stall signal. Re-arming
  // while already armed is a no-op — the first stall already started the
  // clock the spec cares about.
  const armBufferingTimer = useCallback(() => {
    if (bufferingTimerRef.current !== null) return;
    bufferingTimerRef.current = window.setTimeout(() => {
      bufferingTimerRef.current = null;
      dispatch({ type: 'SYNC_MEDIA', buffering: true });
    }, BUFFERING_SETTLE_MS);
  }, []);

  // Clears any pending/settled buffering flag immediately — the indicator
  // must never outlive the stall it reported.
  const clearBuffering = useCallback(() => {
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
    dispatch({ type: 'SYNC_MEDIA', buffering: false });
  }, []);

  // Diagnostic-only: reports an unidentified duration disagreement between
  // what the element measures and what the track declared. Never alters
  // playback. `src` is deliberately excluded from the payload — it embeds the
  // Jellyfin `api_key` (see buildAudioStreamUrl).
  const reportDurationMismatch = useCallback(
    (event: 'durationchange' | 'ended') => {
      const audio = audioRef.current;
      if (!audio) return;
      const track = current;
      const known = track?.durationSeconds;
      if (!durationMismatch(audio.duration, known)) return;
      const key = currentItemIdRef.current;
      if (key && durationReportedRef.current === key) return;
      durationReportedRef.current = key;
      reportFailure('music.player.durationMismatch', 'element/track duration disagree', {
        elementDuration: audio.duration,
        trackDuration: known ?? null,
        currentTime: audio.currentTime,
        readyState: audio.readyState,
        seekableEnd: timeRangeEnd(audio.seekable),
        bufferedEnd: timeRangeEnd(audio.buffered),
        event,
        itemId: key,
        videoId: track?.videoId ?? null,
      });
    },
    [current],
  );

  // Diagnostic-only, distinct from `reportDurationMismatch` above: that one
  // measures how often the disagreement is DETECTED (once per track, on
  // durationchange/ended); this measures how often the guard below actually
  // has to ADVANCE the queue without `ended`. Both numbers matter — a track
  // can show a mismatch and still end normally (e.g. a brief seek glitch).
  const reportPastKnownDuration = useCallback(() => {
    const audio = audioRef.current;
    const track = current;
    reportFailure(
      'music.player.pastKnownDuration',
      'advanced past a known-duration track without waiting for `ended`',
      {
        elementDuration: audio?.duration ?? null,
        trackDuration: track?.durationSeconds ?? null,
        currentTime: audio?.currentTime ?? null,
        itemId: currentItemIdRef.current,
        videoId: track?.videoId ?? null,
      },
    );
  }, [current]);

  // Force the element to `position` whenever a seek/restart bumps the nonce.
  // Re-plays afterwards when playing so a repeat-one loop actually restarts.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // SCRUBBING TO THE END MEANS "next track", NOT "start this one again".
    //
    // The owner dragged the lock-screen scrubber to the end of a song and it
    // restarted from zero instead of advancing. The cause is the two lines
    // that used to be here, in the order they ran: seeking to the end leaves
    // the element FINISHED, and `play()` on a finished element rewinds it to 0
    // and plays again — that is what the spec says it does. The restart won
    // the race against the `ended` event that was meant to move the queue on.
    //
    // Asking for the end is asking for the track to be over, so it goes
    // through the same path a natural finish takes: `advanceFromMediaEvent`,
    // which respects repeat-one and drives the element itself rather than
    // waiting on an event a rewound element will now never fire.
    const duration = audio.duration;
    const seekingToEnd =
      Number.isFinite(duration) &&
      duration > 0 &&
      state.position >= duration - SEEK_TO_END_EPSILON_SECONDS;
    // …but only from a track that is actually playing. A scrubber streams
    // positions while the finger moves, and the ones still in flight when the
    // queue moves on describe the track it just LEFT — dragging to the end
    // skipped three tracks at once because each of those was read as a fresh
    // request against whatever had become current. A track that has not
    // produced audio yet cannot be one the listener is scrubbing to the end
    // of, so those land harmlessly as an ordinary seek.
    if (seekingToEnd && state.isPlaying && audioConfirmedPlayingRef.current) {
      advanceFromMediaEventRef.current();
      return;
    }
    audio.currentTime = state.position;
    if (state.isPlaying) {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        // Guarded on `unlockedRef` like every other rejection path in this
        // file. Unguarded, this was the single place where a transient
        // rejection could switch playback off — and repeat-one reaches it on
        // every loop (the reducer bumps `seekNonce`), so the one path made
        // synchronous to survive a locked screen was also the one whose
        // rejection turned the player off.
        p.catch((err: unknown) => {
          noteRejection('seek', err);
          if (!unlockedRef.current) dispatch({ type: 'SET_PLAYING', value: false });
        });
      }
    }
    // Only the nonce drives this effect; `position`/`isPlaying` are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.seekNonce]);

  // Mirror volume/mute onto the element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = state.volume;
    audio.muted = state.muted;
  }, [state.volume, state.muted]);

  // ── MediaSession: lock-screen / background playback ──────────────────────
  // A playing <audio> plus a populated MediaSession is what lets iOS Safari and
  // Android keep audio going while the screen is locked / the app is
  // backgrounded, and surfaces the play/pause/next/prev + artwork controls on
  // the lock screen. Everything here is a guarded no-op when the API is absent.

  // The action handlers are registered once (below) but must always invoke the
  // LATEST action closures — hold them in a ref refreshed every render so they
  // never capture a stale queue/position.
  const mediaActionsRef = useRef({
    play: () => {},
    pause: () => {},
    next: () => {},
    prev: () => {},
    stop: () => {},
    seekTo: (_seconds: number) => {},
  });
  mediaActionsRef.current = {
    play: () => {
      if (!stateRef.current.isPlaying) {
        runGesture({ type: 'TOGGLE' });
        return;
      }
      // ALREADY "playing" AS FAR AS STATE IS CONCERNED — and this branch is the
      // whole reason the lock-screen buttons stopped working.
      //
      // Measured on the owner's phone: the queue rotates to a track, iOS
      // refuses the new slot's play() (see `rotationPlayRejected`), and the
      // element sits paused at t=0 with the track fully buffered. `isPlaying`
      // stays true because it records INTENT, so the old body — "only act when
      // not playing" — did nothing at all. Pressing play on the lock screen
      // was a no-op, forever, which is exactly what the owner reported.
      //
      // So when intent says playing and audio is not actually flowing, drive
      // the element again from this handler. A MediaSession action IS a user
      // gesture as far as WebKit is concerned, which makes it the one moment a
      // refused element can be un-refused.
      const idx = currentIndexOf(stateRef.current);
      playImperativeRef.current(idx >= 0 ? (stateRef.current.queue[idx] ?? null) : null);
    },
    pause: () => {
      // Pause the ELEMENT here rather than only dispatching. The play/pause
      // effect normally does it, but it runs through React's scheduler, and a
      // backgrounded tab may not run one — the same reason auto-advance was
      // moved out of an effect. A pause the OS asked for that does not stop the
      // sound is worse than a missing button.
      pauseIntentionally(audioRef.current);
      if (stateRef.current.isPlaying) dispatch({ type: 'SET_PLAYING', value: false });
    },
    next: () => runGesture({ type: 'NEXT' }),
    prev: () => runGesture({ type: 'PREV' }),
    // MediaSession's "stop" is a hard stop, not a pause — but the reducer has
    // no distinct stop action, so this settles for the closest honest thing:
    // actually stop the sound. Whether that should also reset position to 0
    // is a product call outside this slice's scope.
    stop: () => {
      if (stateRef.current.isPlaying) dispatch({ type: 'SET_PLAYING', value: false });
    },
    seekTo: (seconds: number) => dispatch({ type: 'SEEK', position: seconds }),
  };

  // Register the OS action handlers once; forward each to the ref so it always
  // runs the newest closure. Unregister (null) on unmount.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    // `stop` is deliberately NOT registered: handing the OS a stop handler is
    // what lets it stop us. It is invoked when the media notification is
    // dismissed or the app is backgrounded — which is what locking the screen
    // does. A missing lock-screen button is a smaller loss than a pause nobody
    // asked for.
    //
    // This was removed once (43e1a32), then reinstated by a revert (f79cb82)
    // on the theory that the owner had been testing in a private/incognito
    // tab. The owner has since confirmed otherwise. The device traces from
    // `useLockDiagnostics` back that up too: playback dies 50-180s after
    // screen lock, right after two `stalled` events — a buffering pattern,
    // not a private-tab artifact. The original fix is restored here.
    //
    // `seekbackward`/`seekforward` are deliberately NOT registered: iOS gives
    // them priority over `nexttrack`/`previoustrack` and shows ±10s buttons on
    // the lock screen instead of next/prev — the exact bug this fixes (a
    // podcast gesture on a song). `seekto` stays: the in-app scrubber drives
    // it and it doesn't compete for a lock-screen button slot.
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => mediaActionsRef.current.play()],
      ['pause', () => mediaActionsRef.current.pause()],
      ['previoustrack', () => mediaActionsRef.current.prev()],
      ['nexttrack', () => mediaActionsRef.current.next()],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') {
            mediaActionsRef.current.seekTo(details.seekTime);
          }
        },
      ],
    ];
    // CLEAR THE SEEK ACTIONS FIRST, explicitly. `navigator.mediaSession` is
    // global to the document and its handlers outlive any component: anything
    // that ever registered `seekbackward`/`seekforward` leaves them in place,
    // and iOS gives those priority — it then draws ±10s buttons INSTEAD of
    // next/previous, which is precisely what the owner sees on his lock
    // screen. Not registering them is not the same as clearing them.
    for (const action of ['seekbackward', 'seekforward'] as MediaSessionAction[]) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* unsupported action */
      }
    }
    for (const [action, handler] of handlers) {
      // Not every action is supported on every browser — ignore rejections.
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
    // RE-REGISTERED ON EVERY TRACK AND EVERY ROTATION, not once at mount.
    //
    // The owner reports the lock screen offering ±10s instead of next/prev.
    // These handlers were installed a single time, but WebKit rebuilds the
    // now-playing session around whichever media element is currently active —
    // and the mixer deliberately rotates between three of them, so from the
    // second track onward the session iOS is drawing may not be the one these
    // were attached to. When it cannot see a next/previous handler it falls
    // back to its own default transport, which is the skip pair.
    //
    // Re-asserting them is idempotent and costs nothing: `setActionHandler`
    // with the same action just replaces the entry. `mediaActionsRef` already
    // keeps the closures fresh, so this is only about WHEN they are attached,
    // never about what they do.
  }, [audioIdentityKey, currentItemId]);

  // Publish the current track's metadata (title / artist / artwork) to the OS,
  // and clear it when nothing is loaded. Keyed on the track reference so it
  // refreshes on every track change.
  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const ms = navigator.mediaSession;
    if (!current) {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist ?? '',
      album: '',
      artwork: mediaSessionArtwork(current.coverUrl),
    });
  }, [current]);

  // Keep the OS play/pause indicator in sync with reality, not merely with
  // intent, for the ONE gap that was actually traced: `state.isPlaying` flips
  // true the instant a gesture dispatches — well before the browser has
  // actually resumed audio — so mirroring it alone reported 'playing' to the
  // lock screen for the FULL length of every measured hang, from the very
  // first sample (`play` at t=0, `mediaSessionState: playing`), through
  // 60-110s of true silence that never produced a single `playing` event.
  // `audioConfirmedPlaying` closes exactly that gap: it is false until the
  // CURRENT play attempt's first real `playing` event, so this says 'playing'
  // only once both the intent AND that first confirmation agree.
  //
  // It deliberately does NOT re-litigate the mid-stream case: once an attempt
  // HAS been confirmed, `audioConfirmedPlaying` stays true through a later
  // `waiting`/`stalled` (see `handleStalled`'s comment) — flipping this back
  // to 'paused' on every buffering blip is the same "tell the OS the music
  // stopped when it is only buffering" mistake `43e1a32`/`2bbcde9` already
  // proved cost the owner his audio on every lock, just delivered through
  // `playbackState` instead of `setPositionState`. 'paused' otherwise (Media
  // Session has no third "buffering" value) covers only: nothing loaded, a
  // real pause, or a play attempt that has not yet been confirmed even once.
  // THE TONE'S STOP SIDE, RECONCILED — because the events alone cannot close it.
  //
  // Every `stopTone()` call hangs off a `pause` or `playing` DOM event, and
  // this file already says why that is not enough (see the keepalive teardown
  // note): pausing an element whose `paused` was ALREADY true fires no `pause`
  // event at all per spec, and `pauseIntentionally` returns early on exactly
  // that case.
  //
  // Adversarial review found the leak that opens: last track of the queue, one
  // stream error below the breaker limit. The skip path starts the tone, the
  // reducer settles on `isPlaying: false` without ever producing a pause event
  // — and the placeholder loops for the rest of the session, holding the OS
  // audio session under a control that reads "paused". That is the same defect
  // the error-give-up branch was just fixed for, entering through a different
  // door.
  //
  // The event-driven stops STAY: they are the only thing that runs in a tab
  // iOS has frozen. This is the reconciler for every path that never produces
  // an event at all.
  useEffect(() => {
    if (!state.isPlaying) stopTone();
  }, [state.isPlaying, stopTone]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    // THIS BUTTON IS ABOUT THE SONG. Nothing else.
    //
    // Two things were folded in here and both were wrong, in opposite
    // directions:
    //
    //   - THE TONE. Counting it made the button say "playing" whenever the
    //     placeholder was running, which is not what the listener is asking
    //     about — they want to know about the song. It also made the control
    //     lie in the other direction later, showing pause while audio was
    //     clearly coming out. The tone's job is to hold the session so the
    //     phone can be locked; that job is done by the element EXISTING and
    //     playing, not by what this field says.
    //   - `audioConfirmedPlaying`. It only turns true on the active element's
    //     own `playing` event, and the mixer rotates which element that is —
    //     so a missed or mis-targeted event left it stuck false and the button
    //     showed pause through a song that was audibly running. A flag that
    //     can desynchronise from reality is a bad thing to draw a control from.
    //
    // `state.isPlaying` is the honest answer: it is what the listener asked
    // for, and it is reconciled from the element's OWN play/pause events
    // (`SYNC_MEDIA`), so it follows the song rather than a side channel.
    //
    // What that gives up, stated plainly: the case this used to guard — a
    // silent hang reporting 'playing' for 60-110s — is no longer covered HERE.
    // It is covered where it belongs instead: the stall watchdog, the escape
    // from a dead graph, and the resume-when-hidden rule all act on that
    // failure directly, rather than merely describing it on the lock screen.
    navigator.mediaSession.playbackState = current
      ? state.isPlaying
        ? 'playing'
        : 'paused'
      : 'none';
  }, [state.isPlaying, current]);

  // Publish position/duration for a freshly-loaded track immediately, using
  // the already-known length (the same `durationSeconds` seed `playImperative`
  // uses for SET_DURATION) instead of waiting for the first throttled
  // `timeupdate` tick below. Without this the lock-screen scrubber shows the
  // PREVIOUS track's duration/position for up to ~1s after a track change —
  // one of the reported lock-screen lies (spec `music-lockscreen-controls`).
  useEffect(() => {
    if (
      !('mediaSession' in navigator) ||
      typeof navigator.mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    if (!current) return;
    const duration = current.durationSeconds;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: 0,
        // Read from the ref, not `state.isPlaying` as a dependency: this
        // effect must run exactly once per track load, not re-fire on every
        // later play/pause toggle (that's `onPause`/`onPlaying`'s job).
        playbackRate: stateRef.current.isPlaying ? 1 : 0,
      });
    } catch {
      /* invalid position state — skip */
    }
  }, [current]);

  // Tell the OS the reported position has stopped advancing. Media Session
  // §4.5 has the OS INTERPOLATE position from the last reported
  // (position, playbackRate) pair — with the existing `playbackRate: 1`
  // always reported from `timeupdate`, the lock-screen counter kept counting
  // up on its own for as long as the OS chose to interpolate, even once
  // playback had actually stopped (the reported "−0:00 forever" symptom).
  // Read live off `audioRef` rather than an event target so every caller
  // (pause/waiting/stalled) can share this without threading the event through.
  // Records what actually happens to playback around a lock; see the hook.
  useLockDiagnostics(
    audioRef,
    lockDiagnosticsTrackRef,
    audioIdentityKey,
    keepaliveStateRef,
    routingRef,
    noteRef,
  );

  const publishFrozenPosition = useCallback(() => {
    if (
      !('mediaSession' in navigator) ||
      typeof navigator.mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(audio.currentTime, 0), duration),
        playbackRate: 0,
      });
    } catch {
      /* invalid position state — skip */
    }
  }, []);

  const value = useMemo<MusicPlayerContextValue>(() => {
    // When a Jam is the chosen output, playback is not a local act. Every
    // caller in the app already funnels through `playNow`/`enqueue`, so this
    // is the one place that has to know — rather than teaching every screen,
    // every row and every menu about Jam.
    //
    // A track sent to a room deliberately carries no per-user Jellyfin URL: a
    // downloaded track travels as its item id and each listener resolves it
    // against their own session, and only a not-yet-downloaded one needs the
    // shared preview proxy.
    const toJamTrack = (track: MusicTrack) => ({
      itemId: track.itemId,
      title: track.title,
      artist: track.artist ?? null,
      coverUrl: track.coverUrl ?? null,
      videoId: track.videoId ?? null,
      durationSeconds: track.durationSeconds ?? null,
      streamUrl: track.streamUrl ?? undefined,
    });

    const sendToJam = (tracks: MusicTrack[], replace: boolean): boolean => {
      const jamId = jamDestination();
      if (!jamId || tracks.length === 0) return false;
      void addTracksToJam(jamId, tracks.map(toJamTrack), replace).catch((cause: unknown) => {
        // Losing a track into a room that refused it, silently, would look
        // exactly like the button not working.
        reportFailure('jam.destination.send', cause, { jamId, replace, count: tracks.length });
      });
      return true;
    };

    const playNow = (tracks: MusicTrack[], startIndex = 0) => {
      if (tracks.length === 0) return;
      // Play replaces what the room is hearing; the owner's rule.
      if (sendToJam(tracks.slice(startIndex), true)) return;
      const index = Math.min(Math.max(startIndex, 0), tracks.length - 1);
      const order = state.shuffle
        ? shuffleOrder(tracks.length, index)
        : naturalOrder(tracks.length);
      runGesture({ type: 'PLAY_QUEUE', tracks, index, order });
    };
    return {
      current,
      queue: state.queue,
      currentIndex,
      isPlaying: state.isPlaying,
      // A stuck flag can never outlive playback — derived, never read raw.
      buffering: visibleBuffering(state),
      position: state.position,
      duration: state.duration,
      volume: state.volume,
      muted: state.muted,
      repeat: state.repeat,
      shuffle: state.shuffle,
      hasNext: state.pos >= 0 && state.pos + 1 < state.order.length,
      autoplay,
      setAutoplay: (value: boolean) => {
        setAutoplayPreference(value);
        setAutoplayState(value);
      },
      playNow,
      playQueue: playNow,
      enqueue: (tracks) => {
        const list = Array.isArray(tracks) ? tracks : [tracks];
        // Adding to the queue appends, the same as it does locally.
        if (sendToJam(list, false)) return;
        runGesture({ type: 'ENQUEUE', tracks: list });
      },
      toggle: () => runGesture({ type: 'TOGGLE' }),
      next: () => runGesture({ type: 'NEXT' }),
      prev: () => runGesture({ type: 'PREV' }),
      seek: (seconds) => dispatch({ type: 'SEEK', position: seconds }),
      setVolume: (v) => dispatch({ type: 'SET_VOLUME', volume: v }),
      toggleMute: () => dispatch({ type: 'SET_MUTED', value: !state.muted }),
      setRepeat: (mode) => dispatch({ type: 'SET_REPEAT', mode }),
      toggleShuffle: () => {
        const nextShuffle = !state.shuffle;
        const order = nextShuffle
          ? shuffleOrder(state.queue.length, currentIndex)
          : naturalOrder(state.queue.length);
        dispatch({ type: 'SET_SHUFFLE', value: nextShuffle, order });
      },
      removeFromQueue: (index) => dispatch({ type: 'REMOVE', index }),
      jumpTo: (index) => runGesture({ type: 'JUMP_TO', index }),
    };
  }, [state, current, currentIndex, runGesture, autoplay]);

  // Both <audio> elements below share this exact handler set, guarded by
  // `e.currentTarget !== audioRef.current`: since a rotation can
  // repoint which physical element `audioRef` calls "active" mid-session,
  // wiring the full state-syncing logic to a FIXED JSX element would leave it
  // listening to the wrong node after a swap. Routing on the live value of
  // `audioRef.current` instead means the swap needs no corresponding change
  // here at all. `onError` is the one handler that behaves differently for
  // the non-active (preloading) element — a failed preload must not touch
  // `consecutiveErrorsRef` or advance a queue that is still playing fine.
  const handleTimeUpdate = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    // Throttle to ~1/s — a raw timeupdate fires 4-60x/s.
    const now = e.currentTarget.currentTime;
    if (Math.abs(now - lastTickRef.current) < 1) return;
    lastTickRef.current = now;
    dispatch({ type: 'SET_POSITION', position: now });

    // The forced-advance guard: iOS's fMP4 defect duplicates the
    // element's reported duration, so `ended` never arrives (or arrives
    // ~2x too late) — see `shouldForceAdvance`'s docstring. Reusing it
    // (not re-deriving the mismatch check here) is what keeps this from
    // ever tripping on a healthy track. At most one forced advance per
    // track load (`pastKnownDurationRef`), same guard shape as
    // `durationReportedRef` above.
    const track = current;
    const itemKey = currentItemIdRef.current;
    // OBSERVE ONLY — deliberately does not advance the queue.
    //
    // This started out as a fix: force the queue on when playback reaches
    // the track's known length, so a doubled element duration could not
    // strand it. An adversarial review took that apart. Advancing here
    // fires on a legitimate scrub past the known length, races `ended`
    // into a double NEXT that silently eats a track, and never rearms
    // under repeat-one. Worse, it could not have fixed the reported
    // symptom anyway: `durationSeconds` is only set by
    // `searchResultToTrack`, so every library / favourites / history
    // queue is outside it.
    //
    // And the premise itself is unproven. The owner's lock screen showed
    // a FULL bar at 2:33 — if the element believed 5:06 we would have
    // published 5:06 and the bar would have sat half empty. That reads
    // like `ended` never arriving at a correct duration, which is a
    // different bug with a different fix.
    //
    // So: measure first. This records how often the condition the fix
    // assumed actually occurs on a real device, at zero risk to playback.
    // Once `music.player.pastKnownDuration` reports (or doesn't) from the
    // owner's phone, we will know whether that fix was ever the answer.
    if (
      itemKey &&
      pastKnownDurationRef.current !== itemKey &&
      shouldForceAdvance(e.currentTarget.duration, track?.durationSeconds, now)
    ) {
      pastKnownDurationRef.current = itemKey;
      reportPastKnownDuration();
    }

    // Feed the lock-screen scrubber (same throttle). setPositionState
    // throws on NaN/Infinity or position > duration, so guard the values.
    if (
      'mediaSession' in navigator &&
      typeof navigator.mediaSession.setPositionState === 'function'
    ) {
      const duration = e.currentTarget.duration;
      if (Number.isFinite(duration) && duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            position: Math.min(Math.max(now, 0), duration),
            playbackRate: 1,
          });
        } catch {
          /* invalid position state — skip this tick */
        }
      }
    }
  };

  const handleLoadedMetadata = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    dispatch({ type: 'SET_DURATION', duration: e.currentTarget.duration || 0 });
  };

  const handleDurationChange = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    dispatch({ type: 'SET_DURATION', duration: e.currentTarget.duration || 0 });
    reportDurationMismatch('durationchange');
  };

  const handleEnded = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    clearStallWatchdog();
    setAudioConfirmedPlaying(false);
    // The gap between this track ending and the next one sounding is the whole
    // reason the tone exists. Cover it from here, inside the media event's own
    // task, so the OS never sees the page fall silent in between.
    if (stateRef.current.isPlaying) startTone();
    reportDurationMismatch('ended');
    advanceFromMediaEvent();
  };

  const handlePlay = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    // Swallowed while the unlock probe's own play() is in flight — it
    // is not a real user play.
    if (probeRef.current) return;
    publishPlaybackState(true);
    dispatch({ type: 'SYNC_MEDIA', playing: true });
  };

  const handlePlaying = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    clearStallWatchdog();
    setAudioConfirmedPlaying(true);
    // A track that ACTUALLY plays proves the chain is healthy again — moved
    // here from `onLoadedMetadata` after adversarial review: `readyState`
    // reaching HAVE_METADATA (1) is exactly the traced hang's own resting
    // state (`ready<=1`, no further event for 60-110s), so resetting the
    // breaker there made it unreachable — a stall-watchdog skip that landed
    // on a track which got as far as metadata (readyState 1) but never
    // played reset the very counter meant to stop it, letting the retry/skip
    // cycle run unbounded through an entire queue instead of tripping
    // `MAX_CONSECUTIVE_AUDIO_ERRORS`. Only a confirmed `playing` proves the
    // chain is actually healthy, not just reachable.
    consecutiveErrorsRef.current = 0;
    // The track is genuinely sounding now, so the placeholder steps aside.
    // Leaving both running is how `92b215f` lost the audio route.
    stopTone();
    // The song is audibly running: say so NOW, not one React render from now.
    // This is the exact event the traces caught reporting 'paused'.
    publishPlaybackState(true);
    // Real audio is flowing again, so the hidden-pause budget is spent on the
    // NEXT outage rather than being exhausted once per session.
    hiddenResumesRef.current = 0;
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
    dispatch({ type: 'SYNC_MEDIA', playing: true, buffering: false });
  };

  // The graph can stop carrying sound without anything noticing.
  //
  // MEASURED on the owner's phone, and this is the number that matters: across
  // 118 diagnostic samples the AudioContext was `interrupted` 11 times and
  // `graphEscaped` was false in EVERY SINGLE ONE. The escape never fired once.
  //
  // Why: the keepalive notices an outage by arming a 1.5s `setTimeout`, and a
  // backgrounded iOS tab does not run timers — the file said so itself, as a
  // known limitation, and the traces now show it is not theoretical. Meanwhile
  // the song keeps its `routing: 'graph'`, so it is being fed into a context
  // that cannot make a sound: playback "running", nothing audible. That is the
  // owner's exact report.
  //
  // Media events, on the other hand, DO arrive while hidden — 19 of those
  // traces are `pause-while-hidden`. So the check rides on them instead of on
  // a timer. Only escapes when the listener actually wants sound: a deliberate
  // pause leaves `isPlaying` false and is none of this function's business.
  const escapeIfGraphIsDead = useCallback(() => {
    if (graphEscapedRef.current) return;
    if (!stateRef.current.isPlaying) return;
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.getRouting(audioRef.current) !== 'graph') return;
    const state = engine.getState();
    if (state === null || state === 'running') return;
    escapeFromAudioGraphRef.current(`context-${state}-observed-from-media-event`);
  }, []);

  const handlePause = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    if (probeRef.current) {
      // Closes the suppression window FROM this task — a `.then()`/
      // `.catch()` microtask would run before this event's task and
      // let the probe's own pause leak through as a user pause.
      probeRef.current = false;
      return;
    }
    // Safari fires `pause` right after `ended`; that pause must not
    // undo the NEXT auto-advance the `ended` handler already dispatched.
    if (e.currentTarget.ended) return;
    // A genuine pause — whoever asked for it (the user, or the OS taking
    // audio focus) — means there is nothing left to watch for on this
    // attempt. Without this, a watchdog armed just before a manual pause
    // would still fire later and force a retry/skip the user never asked
    // for.
    clearStallWatchdog();
    setAudioConfirmedPlaying(false);
    publishFrozenPosition(); // a real pause — stop the lock screen's clock now
    // Before reconciling: if this pause arrived while the graph was already
    // unable to carry sound, this event is the only notice we will get.
    escapeIfGraphIsDead();

    // A PAUSE NOBODY ASKED FOR, WITH THE SCREEN OFF — answer it instead of
    // accepting it.
    //
    // 19 of the owner's traces are exactly this: `pause` arrives while hidden,
    // playback was supposed to be running, and nothing ever starts it again.
    // From his side the music just ends mid-session and stays ended until he
    // touches the phone. The intent is read BEFORE the dispatch below, which
    // is what turns intent into "paused".
    //
    // Driven from this event's own task, like auto-advance, because that is
    // the one context a backgrounded tab still gets to act in — an effect
    // scheduled here may never run at all.
    const el = e.currentTarget;
    // A pause we asked for is never fought. Consumed here, from the event's
    // own task, exactly like the probe window above.
    if (intentionalPauseRef.current) {
      intentionalPauseRef.current = false;
      // Settled into paused, and the placeholder has nothing left to cover:
      // leaving it looping keeps a session alive around silence, which is how
      // the control ends up describing the tone instead of the song.
      stopTone();
      publishPlaybackState(false);
      dispatch({ type: 'SYNC_MEDIA', playing: false, buffering: false });
      return;
    }
    if (
      stateRef.current.isPlaying &&
      !probeRef.current &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      hiddenResumesRef.current < MAX_HIDDEN_RESUME_ATTEMPTS
    ) {
      hiddenResumesRef.current += 1;
      noteRef.current?.('hiddenResume', { attempt: hiddenResumesRef.current });
      const again = el.play();
      if (again && typeof again.then === 'function') {
        again.catch((err: unknown) => {
          // Refused — the OS really is taking the session (a call, a route
          // change, a policy stop). Record why, and let the reconcile below
          // stand: the UI should say paused, because it is.
          noteRejection('hidden-resume', err);
        });
      }
      // Deliberately NOT dispatching a pause here: this attempt may well
      // succeed, and flipping the UI to paused in between would make the lock
      // screen flicker through a state that never really happened. A refusal
      // produces its own `pause` event, which lands back here with the counter
      // already spent and reconciles then.
      return;
    }

    stopTone();
    publishPlaybackState(false);
    dispatch({ type: 'SYNC_MEDIA', playing: false, buffering: false });
  };

  const handleWaiting = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    // Deliberately does NOT touch `audioConfirmedPlaying` — see
    // `handleStalled` just below for why, and the MediaSession playbackState
    // effect for the narrower thing `audioConfirmedPlaying` actually guards.
    //
    // Buffering is NOT stopping. `publishFrozenPosition` reports
    // `playbackRate: 0`, which tells the OS the session is not
    // playing — and a phone that has just locked throttles the
    // network, so `waiting`/`stalled` fire exactly then, not on a
    // real stop. This call was added (43e1a32) and then reverted
    // (f79cb82) on the theory that the owner was testing in a
    // private/incognito tab; he has since confirmed he was not, and
    // the device traces show playback dying 50-180s after lock, right
    // after two `stalled` events — buffering, not incognito. Removed
    // again for good. The cost is a lock-screen scrubber that creeps
    // for a second while buffering, which is worth paying.
    //
    // A stall is also a plausible moment for the graph to have gone quiet
    // underneath us, and it is one of the few events that still arrives while
    // the tab is hidden.
    escapeIfGraphIsDead();
    armBufferingTimer();
  };

  const handleStalled = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    // `audioConfirmedPlaying` is deliberately NOT reset here, on purpose,
    // after adversarial review flagged the first version of this fix for
    // doing exactly that: it fed into MediaSession's `playbackState`, and
    // flipping that to 'paused' on every `waiting`/`stalled` is the same
    // category of "tell the OS the music stopped when it is only buffering"
    // that `43e1a32`/`2bbcde9` already proved harmful on this owner's actual
    // iPhone (audio died on every lock) and deliberately reverted for
    // `setPositionState`'s `playbackRate`. `audioConfirmedPlaying` only ever
    // gates the INITIAL "playing" claim for a play attempt that has not yet
    // produced a single `playing` event (exactly the traced lie: `play()`
    // called, `mediaSessionState: 'playing'` from t=0, then 60-110s of
    // silence with no confirmation ever having arrived) — once that attempt
    // HAS been confirmed, a later mid-stream stall does not retroactively
    // unconfirm it, for the same reason `publishFrozenPosition` does not run
    // here either.
    armBufferingTimer();
  };

  const handleCanPlay = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    clearBuffering();
  };

  const handleError = (e: SyntheticEvent<HTMLAudioElement>) => {
    const el = e.currentTarget;
    if (el !== audioRef.current) {
      // A dead/unreachable resource for the SPECULATIVE next track. The
      // current track is unaffected — do not touch `consecutiveErrorsRef`
      // or advance the queue. Still worth a report: this entire feature's
      // justification is a measurement, and a preload path that silently
      // dies on-device would otherwise produce zero signal (caught by
      // adversarial review — the original comment here claimed a "later
      // effect pass" would retry, which was false without `preloadRetryTick`
      // forcing the preload effect to actually re-run).
      reportFailure('music.player.preloadError', el.error?.message ?? 'preload error', {
        code: el.error?.code,
        videoId: nextTrack?.videoId ?? null,
      });
      // Tell the engine this slot is NOT holding what it thinks it is. It
      // records what it ASKED each element to load, and a fetch that died
      // leaves an element that still looks buffered from the inside: it would
      // be rotated into, play nothing, and then answer 'unchanged' to every
      // later call — permanent silence with the bookkeeping all green.
      // Adversarial review found this; nothing in the engine can observe a
      // load failure on its own.
      // READ THE URL FIRST: `invalidateElement` releases the element, which
      // clears the very attribute this needs. Reading after it always yielded
      // null, so the failure was never charged and the budget never bit — the
      // loop this whole change exists to stop would have survived it.
      const failedUrl = el.getAttribute('src');
      engineRef.current?.invalidateElement(el);
      // Charge the failure against this URL. Past the budget the effect above
      // simply stops handing it out, which ends the loop — the track still
      // plays, it just starts cold instead of from a buffer that was never
      // going to arrive.
      if (failedUrl) {
        const seen = (preloadFailuresRef.current.get(failedUrl) ?? 0) + 1;
        preloadFailuresRef.current.set(failedUrl, seen);
        if (seen >= MAX_PRELOAD_FAILURES) {
          reportFailure(
            'music.player.preloadGaveUp',
            'preload failed too many times; leaving this track cold',
            { videoId: nextTrack?.videoId ?? null, attempts: seen },
          );
        }
      }
      setPreloadRetryTick((tick) => tick + 1);
      return;
    }
    // Nothing listened for this before, and the worker returns 502 for a
    // stale yt-dlp resolve or a throttled upstream — routine, not rare.
    // With no handler the element just stopped: `isPlaying` stayed true,
    // no NEXT was dispatched, and the UI showed a pause button at 0:00
    // forever while the queue refused to advance past the dead track.
    clearStallWatchdog();
    setAudioConfirmedPlaying(false);
    reportFailure('music.player.audioError', el.error?.message ?? 'media error', {
      code: el.error?.code,
      itemId: currentItemIdRef.current,
    });

    consecutiveErrorsRef.current += 1;
    // Skipping past one broken track is right; sprinting through a whole
    // radio queue because the worker is down is not. Stop and stay stopped
    // so the failure is visible instead of looking like an instant finish.
    if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_AUDIO_ERRORS) {
      // STOP THE PLACEHOLDER TOO. Nothing did this before, and REPRODUCED live
      // against production: a track whose stream 502s left the tone looping for
      // as long as the page stayed open — 68 seconds in the measurement, with
      // `readyState` 0 and not one byte of the song. The phone keeps a
      // now-playing session, the panel keeps a button, and nothing will ever
      // come out of it. Giving up has to mean giving up audibly.
      stopTone();
      publishPlaybackState(false);
      dispatch({ type: 'SET_PLAYING', value: false });
      return;
    }
    // Skipping a dead track is a LONGER gap than a normal one, so cover it the
    // way `onEnded` does — otherwise the session lapses mid-skip and a locked
    // phone loses its panel on exactly the tracks that most need to be skipped.
    if (stateRef.current.isPlaying) startTone();
    // Same reasoning as `onEnded`: skipping a dead track has to drive the
    // element from this handler, or a locked phone never resumes.
    advanceFromMediaEvent();
  };

  return (
    <MusicPlayerContext.Provider value={value}>
      {/* THE THREE MIXER SLOTS. Peers, not a main element plus spares: each
          one takes its turn as `current`, `next` and `prev` as the engine
          rotates roles, and all three are routed into the one AudioContext
          (see musicAudioEngine.ts). They carry identical props for exactly
          that reason — anything asymmetric here would become a property of a
          ROLE, and roles move between these nodes.

          `preload="auto"` on all three: the hint is honoured even under an
          explicit `.load()`, and every one of them is expected to buffer a
          track it has been given. The old arrangement had to flip this
          attribute on every promotion to keep it matching the element's
          current role; with three equal slots there is nothing to flip.

          Every handler ignores events from an element that is not currently
          active (`e.currentTarget !== audioRef.current`), which is what lets
          one handler set serve whichever node the rotation left in charge. */}
      <audio
        ref={setSlotA}
        hidden
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPlaying={handlePlaying}
        onPause={handlePause}
        onWaiting={handleWaiting}
        onStalled={handleStalled}
        onCanPlay={handleCanPlay}
        onError={handleError}
      />
      <audio
        ref={setSlotB}
        hidden
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPlaying={handlePlaying}
        onPause={handlePause}
        onWaiting={handleWaiting}
        onStalled={handleStalled}
        onCanPlay={handleCanPlay}
        onError={handleError}
      />
      <audio
        ref={setSlotC}
        hidden
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPlaying={handlePlaying}
        onPause={handlePause}
        onWaiting={handleWaiting}
        onStalled={handleStalled}
        onCanPlay={handleCanPlay}
        onError={handleError}
      />
      {/* THE ESCAPE ELEMENT — the fourth, and the only one never routed into
          the AudioContext, so it is the one place left that can still make a
          sound if that graph dies (see `escapeFromAudioGraph`). Routing is
          irreversible per spec: an element bound to a context that later stops
          carrying sound is mute forever, and all three slots above are bound.
          This one is the way out.

          It plays exactly two things in its life: 50ms of embedded silence on
          the first user gesture (iOS's per-element unlock, if that is what iOS
          wants), and, if the graph is ever lost, the song itself for the rest
          of the page load. `preload="none"` because until that day comes it
          must cost nothing at all. */}
      {/* THE TONE — the owner's "pista falsa": a real media element looping
          embedded silence, started inside the gesture before the track is even
          resolved. That is what lets the phone be locked immediately instead
          of after the 5-10s the real track takes to arrive: iOS only treats a
          page as playing when a MEDIA ELEMENT is, and the Web Audio graph this
          replaces never qualified.

          No handlers: it must never be mistaken for the active element, never
          drive state, and never advance the queue. It steps aside the moment
          the real track is confirmed sounding (`handlePlaying`) and comes back
          to cover the gap at `ended`. */}
      <audio
        ref={setToneSlot}
        hidden
        preload="auto"
        loop
      />
      <audio
        ref={setSlotD}
        hidden
        preload="none"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPlaying={handlePlaying}
        onPause={handlePause}
        onWaiting={handleWaiting}
        onStalled={handleStalled}
        onCanPlay={handleCanPlay}
        onError={handleError}
      />
      {children}
    </MusicPlayerContext.Provider>
  );
}
