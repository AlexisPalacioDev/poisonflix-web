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
import {
  createSilentKeepalive,
  type AudioRouting,
  type KeepaliveContextState,
} from './silentKeepalive';
import { silentAudioClip } from './silentAudioClip';
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

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Two physical <audio> elements so the NEXT track can be fully buffered on
  // a SEPARATE element while the CURRENT one is still playing — see the
  // preload effect below for the measurement this is built on. `audioRef`
  // always points at whichever element is "active" (the one driving state and
  // eligible to play); `preloadAudioRef` always points at the other one. They
  // are NOT tied 1:1 to a fixed JSX element: `promoteFromPreload` swaps which
  // physical node each one points at when a preloaded track is promoted, so
  // every other reference to `audioRef.current` in this file keeps working
  // unmodified after a swap. `setSlotA`/`setSlotB` are the only things React
  // itself ever calls (once, at mount/unmount) — the swap logic reassigns
  // `.current` on these two ref objects directly and React never overwrites
  // that in between, because neither JSX element's `ref` prop identity ever
  // changes.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preloadAudioRef = useRef<HTMLAudioElement | null>(null);
  // The third physical element, and the reason there are three rather than
  // two. The owner's design routes the song into the keepalive's AudioContext
  // so the tone and the song leave through one origin — and that bind is
  // irreversible (see silentKeepalive.ts's "ONE AUDIO ORIGIN" note): an
  // element that has been routed can never be handed back to the speaker, not
  // by disconnecting it, not by a second context, not by anything.
  //
  // WHICH ELEMENT STAYS ROUTED AND WHICH IS RESERVED, and why it is not one of
  // the two above: `promoteFromPreload` swaps which of slots A and B is
  // active, so over a session BOTH of them end up being the playing element
  // and therefore BOTH have to be routed for the "one origin" property to hold
  // on every track rather than every other track. Reserving one of them
  // instead would mean either half the tracks leave through a second origin —
  // the exact thing this feature exists to remove — or giving up double
  // buffering, which is itself one of the anti-freeze measures already
  // deployed (b7cbb6c) and the only reason a preloaded track can start with no
  // network at all. So slots A and B are both routed, and slot C is a third
  // element that is never routed, never preloads, never plays a song, and
  // exists purely so there is somewhere audible left to go if the graph dies.
  //
  // The cost of that choice, stated plainly: once the escape happens, the two
  // double-buffer elements are captive for the rest of the page load and
  // playback continues single-buffered on slot C. Sound without preloading
  // beats preloading without sound.
  const escapeAudioRef = useRef<HTMLAudioElement | null>(null);
  const setSlotA = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
  }, []);
  const setSlotB = useCallback((el: HTMLAudioElement | null) => {
    preloadAudioRef.current = el;
  }, []);
  const setSlotC = useCallback((el: HTMLAudioElement | null) => {
    escapeAudioRef.current = el;
  }, []);
  const lastTickRef = useRef(0);
  // Consecutive <audio> failures. Reset by a successful load; see onError below.
  const consecutiveErrorsRef = useRef(0);
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
  // consumed (and cleared) by `promoteFromPreload` and by that same effect
  // once the eligible next track changes or stops being eligible.
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
  // (slot C). One-way: the two double-buffer elements are captive from that
  // point on, so promotion and preloading must both stop. Mirrored into React
  // state below because the preload effect is keyed on a derived value.
  const graphEscapedRef = useRef(false);
  const [graphEscaped, setGraphEscaped] = useState(false);
  // Whether slot C has been given its gesture-backed unlock play (see the
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
  const keepaliveRef = useRef<ReturnType<typeof createSilentKeepalive> | null>(null);
  if (!keepaliveRef.current) {
    keepaliveRef.current = createSilentKeepalive({
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
  keepaliveStateRef.current = () => keepaliveRef.current?.getState() ?? null;
  // Whether the ACTIVE element's audio currently leaves through the graph, and
  // whether the escape has already happened. Same live-read pattern.
  const routingRef = useRef<() => { routing: AudioRouting; escaped: boolean }>(() => ({
    routing: 'direct',
    escaped: false,
  }));
  routingRef.current = () => ({
    routing: keepaliveRef.current?.getRouting(audioRef.current) ?? 'direct',
    escaped: graphEscapedRef.current,
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
  // Bumped exactly when `promoteFromPreload` repoints `audioRef.current` at a
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
  const promoteFromPreload = useCallback((url: string) => {
    const promoted = preloadAudioRef.current;
    if (!promoted) return false;
    const demoted = audioRef.current;
    // The demoted element may still be actively playing — a manual skip
    // pressed before the current track naturally ended. Left alone, both
    // elements would produce sound at once; only iOS's "only one media focus"
    // rule (not our own bookkeeping) would eventually paper over that, and
    // not reliably.
    if (demoted && !demoted.paused) demoted.pause();
    audioRef.current = promoted;
    preloadAudioRef.current = demoted;
    srcUrlRef.current = url;
    preloadedUrlRef.current = null;
    // `preload` is a property of the physical DOM node, NOT of the "role" —
    // swapping which ref points at which node does nothing to it on its own.
    // Caught by adversarial review: without this, the element that becomes
    // the new PRELOADER after an odd number of promotions is left holding
    // `preload="none"` from when it was still the JSX-declared main element,
    // and the resource-selection algorithm honours that hint even under an
    // explicit `.load()` call — silently turning preloading off on every
    // other transition. Assign it explicitly so it always matches the
    // element's CURRENT role, not its original JSX one.
    promoted.preload = 'none';
    if (demoted) demoted.preload = 'auto';
    // The volume/mute effect further down is keyed on [state.volume,
    // state.muted] and will not re-fire from a bare swap (neither value
    // changed) — apply them to the newly-active element directly so a
    // muted/volume-adjusted session does not silently un-mute itself the
    // moment a preloaded track takes over.
    promoted.volume = stateRef.current.volume;
    promoted.muted = stateRef.current.muted;
    setAudioIdentityKey((key) => key + 1);
    return true;
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
    stallTimerRef.current = window.setTimeout(() => {
      stallTimerRef.current = null;
      stallCheckRef.current(key, 0);
    }, STALL_WATCHDOG_MS);
  }, []);

  // MITIGATION for the unresolved per-element-vs-per-document autoplay-unlock
  // risk documented on the belt-and-suspenders unlock effect below: if the
  // PROMOTED element's very first play() rejects, do not let the track sit
  // silent. Reverse `promoteFromPreload`'s ref swap and preload flags, then
  // load+play `url` on the element that was demoted back into "active" — that
  // element is the one guaranteed to have received a real user gesture at
  // some point this session (it is how audio ever started playing at all), so
  // it is the one place still known to be unlocked if iOS's unlock turns out
  // to be scoped per-element. Worst case this degrades to EXACTLY the
  // pre-double-buffering behaviour: a fresh `.src` + `.load()` + `.play()` on
  // a single already-unlocked element — measured at 10/21 successful
  // locked-screen transitions, not 0/21. Also reports via `reportFailure`
  // under its own scope: whether this ever fires on a real device is the one
  // piece of evidence that tells us if iOS's unlock is per-element at all,
  // and today there is none.
  //
  // `promotedElement` is the identity `playImperative` captured AT THE MOMENT
  // it promoted — a rejection is delivered asynchronously (a promise
  // `.catch`), and adversarial review found a real path in this same file
  // that can move `audioRef.current`/`srcUrlRef` again before that rejection
  // lands: a manual skip (or another auto-advance) while THIS promotion's
  // play() is still pending (`promoteFromPreload`'s `demoted.pause()` on the
  // NEW attempt rejects the OLD one). Acting on a stale rejection would
  // silently move a NEWER, already-correct playback state backwards — one
  // traced case left the player stuck on the wrong track with no
  // self-correction. Bailing out when the world has moved on since this
  // specific promotion is what keeps the fallback confined to the one case it
  // exists for.
  //
  // This guard does NOT, by itself, cover the stall watchdog's own retry
  // (`audio.load()` on the SAME element aborting THIS SAME pending play()) —
  // a second adversarial pass confirmed neither `audioRef.current` nor
  // `srcUrlRef.current` change in that case, so the identity check above
  // would pass right through it. That path is closed instead at the call
  // site in `playImperative`, by never invoking this function at all for an
  // `AbortError` — see the comment there for why that rejection reason
  // specifically means "this file interrupted itself", not "iOS refused".
  const fallbackFromFailedPromotion = useCallback(
    (target: MusicTrack | null, url: string, promotedElement: HTMLAudioElement) => {
      if (audioRef.current !== promotedElement || srcUrlRef.current !== url) {
        // Stale: something else (a later gesture, another auto-advance,
        // another promotion) already moved playback on from the attempt
        // that just rejected. Acting now would undo THAT progress, not fix
        // this one.
        return;
      }
      const failed = audioRef.current;
      const original = preloadAudioRef.current;
      reportFailure(
        'music.player.promotionPlayRejected',
        'promoted preload element play() rejected; falling back to the original element',
        { itemId: target?.itemId ?? null, videoId: target?.videoId ?? null },
      );
      if (!original) return; // nothing to fall back to (only one element ever existed)
      if (failed && !failed.paused) failed.pause();
      audioRef.current = original;
      preloadAudioRef.current = failed;
      srcUrlRef.current = url;
      preloadedUrlRef.current = null;
      original.preload = 'none';
      if (failed) failed.preload = 'auto';
      original.volume = stateRef.current.volume;
      original.muted = stateRef.current.muted;
      original.src = url;
      original.load();
      setAudioIdentityKey((key) => key + 1);
      // Fresh full-budget watchdog for this new attempt, defensively — NOT a
      // continuation of whatever stage/timeout the interrupted attempt's
      // watchdog was on. (The specific scenario this was first written to
      // guard against — reaching the fallback FROM the stall watchdog's own
      // stage-1 retry — turned out to be closed one layer up instead: that
      // retry's `audio.load()` rejects the pending promotion with
      // `AbortError`, which the caller in `playImperative` now filters out
      // before ever calling this function at all. This call stays anyway as
      // defense-in-depth for whatever genuine, non-Abort rejection DOES
      // reach here — it should never depend on the interrupted attempt's
      // watchdog stage having been favourable.)
      armStallWatchdog(target?.itemId ?? null);
      // Not gesture-synchronous (this runs from a rejected promise's .catch, a
      // microtask) — but so is the stall watchdog's own retry `play()` further
      // down, on the SAME reasoning: `original` already produced a real
      // `playing` event earlier this session, and iOS's on-device probe
      // (`020406d`) already confirmed a non-gesture play() is accepted on an
      // element that has previously played, with a new src, from a media-event
      // task. This is not a new risk, just the existing one reused.
      const p = original.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          unlockedRef.current = true;
        }).catch(() => {
          // Both elements rejected. Nothing further to fall back to — same
          // "gesture-initiated, don't lie about state" swallow the caller
          // already applies to every other play() rejection in this file.
        });
      }
    },
    [armStallWatchdog],
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
  // That is slot C. This function moves playback onto it: same URL, same
  // position, same volume/mute, and it becomes `audioRef.current` so every
  // other part of this file — MediaSession, the stall watchdog, the seek
  // effect, the diagnostics — keeps working with no knowledge that anything
  // moved. Double buffering stops for the rest of the page load, because the
  // two elements it needs are the captive ones.
  //
  // One-way and at-most-once by construction: there is exactly one unrouted
  // element, so there is exactly one escape.
  //
  // WHAT THIS CANNOT PROMISE, said out loud rather than buried: slot C's
  // `play()` here does NOT run inside a user gesture — the whole point is that
  // it fires while the screen is locked. Whether iOS honours it depends on
  // whether its autoplay unlock is per-element or per-document, which this
  // codebase has never been able to determine (the same open question
  // `fallbackFromFailedPromotion` was written for). The unlock in the gesture
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
      keepaliveRef.current?.close();
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
      // cannot happen while slot C is rendered unconditionally.
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
      if (!audioRef.current) return;
      const url = trackSrc(target);
      // The exact element THIS call promoted, if it did — captured so the
      // (asynchronous) rejection handler below can tell a fallback that still
      // applies from a stale one; see `fallbackFromFailedPromotion`'s
      // docstring for the race this closes.
      let promotedElement: HTMLAudioElement | null = null;
      // Only (re)assign src when the target actually differs from what's loaded;
      // re-assigning the same src would reset currentTime and stall playback.
      if (url && srcUrlRef.current !== url) {
        // A gap of unknown length is about to open before the NEXT `playing`
        // event confirms real audio — never let a stale confirmation from the
        // PREVIOUS attempt keep MediaSession claiming 'playing' through it.
        setAudioConfirmedPlaying(false);
        // After the escape, slots A and B are captive in a dead audio graph:
        // promoting one of them would hand the track to an element that
        // cannot make a sound. `preloadedUrlRef` is already cleared in that
        // case, so this guard is belt-and-braces — and it is the kind of
        // belt worth wearing, because the failure it prevents is silent.
        const wasPromoted =
          !graphEscapedRef.current &&
          url === preloadedUrlRef.current &&
          promoteFromPreload(url);
        if (wasPromoted) {
          promotedElement = audioRef.current;
        } else {
          const audio = audioRef.current;
          srcUrlRef.current = url;
          audio.src = url;
        }
        // Seed the scale from what the source already told us. Without this a
        // streamed preview shows 0:00 and a full-looking bar until (or unless)
        // the element works the length out for itself.
        const known = target?.durationSeconds;
        if (typeof known === 'number' && Number.isFinite(known) && known > 0) {
          dispatch({ type: 'SET_DURATION', duration: known });
        }
      }
      const audio = audioRef.current;
      if (!audio) return;
      armStallWatchdog(target?.itemId ?? null);
      // Silent keepalive (see silentKeepalive.ts) starts BEFORE the real
      // play() below, and the order is the whole point.
      //
      // The tone is the floor the session stands on: it has to already be
      // sounding while the real track is still loading, because that load is
      // exactly the stretch with no audio, and no audio is what lets iOS
      // freeze the tab. Starting it afterwards puts the cushion in place
      // after the fall.
      //
      // It also decides who holds the audio route. WebKit hands that to
      // whoever asked LAST — the same rule behind the muted preload element
      // stealing the sound (see the gesture handler further down). Silence
      // first, song second, so the song is the one holding it.
      //
      // Synchronous and never awaited, so it cannot delay the play() call
      // below — this function's gesture-synchronous rule (see its docstring)
      // still holds. Any failure (no Web Audio, a rejected resume(),
      // anything) is swallowed inside `start()` and cannot touch playback.
      keepaliveRef.current?.start();
      // Mount the song ON TOP of the tone, in the same context: one origin,
      // the tone underneath it, the song mixed in. This is the owner's design
      // — "ambos salen por el mismo canal, solo que uno se monta antes" — and
      // the order above is what makes "antes" true.
      //
      // Deliberately AFTER `start()` (the context has to exist) and BEFORE
      // `play()` (so the element is already carried when it begins to sound,
      // instead of switching origins mid-note). Never routes once the escape
      // has happened: slot C is the one element that must stay reachable.
      // Refusing is always safe — an unrouted element simply plays out of
      // itself, which is exactly today's shipped behaviour.
      if (!graphEscapedRef.current) {
        keepaliveRef.current?.routeElement(audio);
      }
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          unlockedRef.current = true;
        }).catch((err: unknown) => {
          // MITIGATION (see `fallbackFromFailedPromotion`'s docstring): the
          // promoted preload element has never received a user gesture of
          // its own — if iOS's autoplay unlock turns out to be per-element
          // rather than per-document, its play() rejects here, silently,
          // every single time. Falling back to the original (gesture-backed)
          // element is what keeps that scenario at today's 10/21 instead of
          // dropping to 0/21.
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
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (!isAbort && promotedElement && url) {
            fallbackFromFailedPromotion(target, url, promotedElement);
          }
          // Gesture-initiated: don't flip to paused. If the element is still
          // locked the belt-and-suspenders unlock listener handles it; once
          // unlocked, transient rejections must not lie about play state.
        });
      }
    },
    [trackSrc, promoteFromPreload, armStallWatchdog, fallbackFromFailedPromotion],
  );

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
  const advanceFromMediaEvent = useCallback(() => {
    const action: Action = { type: 'NEXT', auto: true };
    if (stateRef.current.repeat === 'one') {
      dispatch(action);
      return;
    }
    runGesture(action);
  }, [runGesture]);

  // The watchdog's actual check, run from the timers `armStallWatchdog` sets
  // up. Reassigned every render (not a useCallback) purely so it always
  // closes over today's `current`/`advanceFromMediaEvent` — the timer that
  // invokes it is armed once but may fire many renders later.
  stallCheckRef.current = (key, stage) => {
    if (stallWatchdogKeyRef.current !== key || stallRetryStageRef.current !== stage) return;
    const audio = audioRef.current;
    if (!audio) return;
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

  // Point the element at the current track. Guarded against the gesture path:
  // when a gesture already assigned this exact URL, skip the load() so the
  // declarative effect never fights the in-flight gesture play.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!currentSrc) {
      srcUrlRef.current = null;
      durationReportedRef.current = null;
      pastKnownDurationRef.current = null;
      setAudioConfirmedPlaying(false);
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    if (srcUrlRef.current === currentSrc) return; // already loaded (e.g. by the gesture)
    srcUrlRef.current = currentSrc;
    durationReportedRef.current = null;
    pastKnownDurationRef.current = null;
    setAudioConfirmedPlaying(false);
    audio.src = currentSrc;
    audio.load();
    // `isPlaying` is intentionally not a dep — the play/pause effect below owns it.
  }, [currentSrc]);

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
  // interruption. The alternative (keep buffering through a pause) would
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
  // from an `ended` handler" — preloaded is the word doing the work. Nothing
  // has been, since the single element that plays everything is
  // `preload="none"`. Fetching the next track's bytes now, onto a DIFFERENT
  // element that is never told to play, and promoting THAT element (see
  // `promoteFromPreload`) when the track actually changes, is what turns that
  // finding into something more than a fact nothing acts on.
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
    const preload = preloadAudioRef.current;
    if (!preload) return;
    if (!nextSrc) {
      // Checked against the DOM, not just `preloadedUrlRef` — a promotion
      // (`promoteFromPreload`) already clears that ref as part of the swap,
      // but the demoted element can still be holding the just-finished
      // track's `src` (e.g. the queue ran out right after a promotion, so
      // this branch is reached with a ref that's already null). Gating only
      // on the ref left that stale resource — and its now-permanent
      // `preload="auto"` from the swap — sitting loaded forever.
      if (preloadedUrlRef.current !== null || preload.hasAttribute('src')) {
        preloadedUrlRef.current = null;
        preload.removeAttribute('src');
        preload.load();
      }
      return;
    }
    if (preloadedUrlRef.current === nextSrc) return; // already (being) loaded
    preloadedUrlRef.current = nextSrc;
    preload.src = nextSrc;
    preload.load();
    // `preloadRetryTick` has no bearing on WHAT gets loaded (only `nextSrc`
    // does) — it exists purely so `handleError`'s non-active branch can force
    // this effect to run again after a failed attempt, even when the
    // eligible next track hasn't changed.
  }, [nextSrc, preloadRetryTick]);

  // Reflect the isPlaying flag onto the element. A rejected play() while the
  // element is still locked (autoplay policy, no src) flips the flag back so the
  // UI stays truthful — but only before the first successful play; afterwards
  // the element is unlocked and transient rejections must not lie.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItemId) return;
    if (state.isPlaying) {
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          unlockedRef.current = true;
        }).catch(() => {
          if (!unlockedRef.current) dispatch({ type: 'SET_PLAYING', value: false });
        });
      }
    } else {
      audio.pause();
    }
  }, [state.isPlaying, currentItemId]);

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
    if (!state.isPlaying) keepaliveRef.current?.suspend();
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
  //     `src` + `load()`, and `promoteFromPreload` never plays at all.
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
  // covered by the MITIGATION instead — `fallbackFromFailedPromotion` hands
  // the track back to the gesture-backed element and reports
  // `music.player.promotionPlayRejected`, which is also the only evidence
  // that would tell us the per-element theory is true at all. It is now the
  // only net under that risk, so it must stay intact.
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
      // What it buys: slot C has then played once from a user gesture, which
      // is what iOS requires per element IF its unlock is per-element. If it
      // is per-document instead, this is harmless dead weight. Nobody has
      // been able to determine which — so this is written to be safe under
      // both readings rather than correct under one.
      const escape = escapeAudioRef.current;
      const clip = silentAudioClip();
      if (escape && clip && !escapeUnlockAttemptedRef.current) {
        escapeUnlockAttemptedRef.current = true;
        try {
          escape.src = clip;
          const ep = escape.play();
          if (ep && typeof ep.then === 'function') {
            ep.then(() => {
              escapeUnlockPlayedRef.current = true;
            }).catch(() => {
              // Refused. The escape can still try again from its own
              // rejection path; nothing here is worth reporting on its own.
            });
          }
        } catch {
          // Never let the escape's preparation break the gesture that is
          // about to start the music.
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
    // a keyboard-only session would start music with slot C never having
    // played — and slot C only matters when it is asked to take over without
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
      keepaliveRef.current?.close();
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
    audio.currentTime = state.position;
    if (state.isPlaying) {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => dispatch({ type: 'SET_PLAYING', value: false }));
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
      if (!stateRef.current.isPlaying) runGesture({ type: 'TOGGLE' });
    },
    pause: () => {
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
  }, []);

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
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = current
      ? state.isPlaying && audioConfirmedPlaying
        ? 'playing'
        : 'paused'
      : 'none';
  }, [state.isPlaying, audioConfirmedPlaying, current]);

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
  // `e.currentTarget !== audioRef.current`: since `promoteFromPreload` can
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
    reportDurationMismatch('ended');
    advanceFromMediaEvent();
  };

  const handlePlay = (e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== audioRef.current) return;
    // Swallowed while the unlock probe's own play() is in flight — it
    // is not a real user play.
    if (probeRef.current) return;
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
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
    dispatch({ type: 'SYNC_MEDIA', playing: true, buffering: false });
  };

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
      preloadedUrlRef.current = null;
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
      dispatch({ type: 'SET_PLAYING', value: false });
      return;
    }
    // Same reasoning as `onEnded`: skipping a dead track has to drive the
    // element from this handler, or a locked phone never resumes.
    advanceFromMediaEvent();
  };

  return (
    <MusicPlayerContext.Provider value={value}>
      <audio
        ref={setSlotA}
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
      {/* The preload element: only ever loads a resource, never plays one —
          see the preload effect above. `preload="auto"` (vs. the main
          element's deliberate "none") because this element ONLY ever holds
          the definite next-up track while the current one is actively
          playing, so eager buffering is exactly the intended behaviour here. */}
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
      {/* The escape element: never routed into the keepalive's AudioContext,
          so it is the one place left that can still make a sound if that
          graph dies — see `escapeFromAudioGraph`. It plays exactly two things
          in its life: 50ms of embedded silence on the first user gesture (to
          satisfy iOS's per-element unlock, if that is what iOS wants), and,
          if the graph is ever lost, the song itself for the rest of the page
          load. `preload="none"` because until that day comes it must cost
          nothing at all. It carries the same handlers as the other two: the
          moment it becomes `audioRef.current` it is the active element, and
          every handler already ignores events from any element that is not
          (`e.currentTarget !== audioRef.current`). */}
      <audio
        ref={setSlotC}
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
