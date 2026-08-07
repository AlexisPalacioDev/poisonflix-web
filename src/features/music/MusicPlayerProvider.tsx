import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../../hooks/useAuth';
import { getAutoplayPreference, setAutoplayPreference } from '../../lib/domain/musicPrefs';
import { buildAudioStreamUrl } from '../../lib/domain/streamResolver';
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
  visibleBuffering,
  type Action,
  type MusicPlayerContextValue,
  type MusicTrack,
} from './musicPlayerCore';

// `TimeRanges.end()` throws `IndexSizeError` on an empty range (jsdom
// exercises this: the element starts with no seekable/buffered data at all).
// Diagnostics must never crash on that — read through this null-returning
// guard instead of calling `.end()` directly.
function timeRangeEnd(ranges: TimeRanges): number | null {
  try {
    return ranges.length > 0 ? ranges.end(ranges.length - 1) : null;
  } catch {
    return null;
  }
}

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

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  const currentIndex = currentIndexOf(state);
  const current = currentIndex >= 0 ? (state.queue[currentIndex] ?? null) : null;

  const currentItemId = current?.itemId ?? null;
  // Read inside the error handler, which must not re-create on every track.
  const currentItemIdRef = useRef<string | null>(null);
  currentItemIdRef.current = currentItemId;

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

  // Drive the element to play a target track SYNCHRONOUSLY, from inside a user
  // gesture. This is the iOS-critical path: play() must be called within the
  // same call stack as the click/touch, before React flushes any effect.
  const playImperative = useCallback(
    (target: MusicTrack | null) => {
      const audio = audioRef.current;
      if (!audio) return;
      const url = trackSrc(target);
      // Only (re)assign src when the target actually differs from what's loaded;
      // re-assigning the same src would reset currentTime and stall playback.
      if (url && srcUrlRef.current !== url) {
        srcUrlRef.current = url;
        audio.src = url;
        // Seed the scale from what the source already told us. Without this a
        // streamed preview shows 0:00 and a full-looking bar until (or unless)
        // the element works the length out for itself.
        const known = target?.durationSeconds;
        if (typeof known === 'number' && Number.isFinite(known) && known > 0) {
          dispatch({ type: 'SET_DURATION', duration: known });
        }
      }
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          unlockedRef.current = true;
        }).catch(() => {
          // Gesture-initiated: don't flip to paused. If the element is still
          // locked the belt-and-suspenders unlock listener handles it; once
          // unlocked, transient rejections must not lie about play state.
        });
      }
    },
    [trackSrc],
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
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    if (srcUrlRef.current === currentSrc) return; // already loaded (e.g. by the gesture)
    srcUrlRef.current = currentSrc;
    durationReportedRef.current = null;
    pastKnownDurationRef.current = null;
    audio.src = currentSrc;
    audio.load();
    // `isPlaying` is intentionally not a dep — the play/pause effect below owns it.
  }, [currentSrc]);

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

  // Belt-and-suspenders: unlock the media element on the very first user
  // interaction anywhere in the document. If a track is loaded but paused, a
  // guarded no-op play()->pause() satisfies iOS's user-activation requirement
  // so a later programmatic play() (e.g. auto-advance on `ended`) is allowed.
  // Safe when nothing is loaded — it does nothing. Fires at most once.
  useEffect(() => {
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
      const audio = audioRef.current;
      if (!audio) return;
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
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('touchend', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
    };
  }, []);

  // The settle timer lives in a ref (armed/cleared from event handlers, not
  // effects) so it must be cleared explicitly on unmount too.
  useEffect(() => {
    return () => {
      if (bufferingTimerRef.current !== null) {
        window.clearTimeout(bufferingTimerRef.current);
      }
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
      ['stop', () => mediaActionsRef.current.stop()],
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

  // Keep the OS play/pause indicator in sync with our state.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
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
    const playNow = (tracks: MusicTrack[], startIndex = 0) => {
      if (tracks.length === 0) return;
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
      enqueue: (tracks) =>
        runGesture({ type: 'ENQUEUE', tracks: Array.isArray(tracks) ? tracks : [tracks] }),
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

  return (
    <MusicPlayerContext.Provider value={value}>
      <audio
        ref={audioRef}
        hidden
        preload="none"
        onTimeUpdate={(e) => {
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
        }}
        onLoadedMetadata={(e) => {
          // A track that loads proves the chain is healthy again.
          consecutiveErrorsRef.current = 0;
          dispatch({ type: 'SET_DURATION', duration: e.currentTarget.duration || 0 });
        }}
        onDurationChange={(e) => {
          dispatch({ type: 'SET_DURATION', duration: e.currentTarget.duration || 0 });
          reportDurationMismatch('durationchange');
        }}
        onEnded={() => {
          reportDurationMismatch('ended');
          dispatch({ type: 'NEXT', auto: true });
        }}
        onPlay={() => {
          // Swallowed while the unlock probe's own play() is in flight — it
          // is not a real user play.
          if (probeRef.current) return;
          dispatch({ type: 'SYNC_MEDIA', playing: true });
        }}
        onPlaying={() => {
          if (bufferingTimerRef.current !== null) {
            window.clearTimeout(bufferingTimerRef.current);
            bufferingTimerRef.current = null;
          }
          dispatch({ type: 'SYNC_MEDIA', playing: true, buffering: false });
        }}
        onPause={(e) => {
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
          publishFrozenPosition(); // a real pause — stop the lock screen's clock now
          dispatch({ type: 'SYNC_MEDIA', playing: false, buffering: false });
        }}
        onWaiting={() => {
          armBufferingTimer();
          // A stall means the OS is about to start interpolating position from
          // a value that has genuinely stopped moving — freeze it immediately
          // rather than waiting for the (separate, UI-only) settle window.
          publishFrozenPosition();
        }}
        onStalled={() => {
          armBufferingTimer();
          publishFrozenPosition();
        }}
        onCanPlay={clearBuffering}
        onError={(e) => {
          // Nothing listened for this before, and the worker returns 502 for a
          // stale yt-dlp resolve or a throttled upstream — routine, not rare.
          // With no handler the element just stopped: `isPlaying` stayed true,
          // no NEXT was dispatched, and the UI showed a pause button at 0:00
          // forever while the queue refused to advance past the dead track.
          const el = e.currentTarget;
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
          dispatch({ type: 'NEXT', auto: true });
        }}
      />
      {children}
    </MusicPlayerContext.Provider>
  );
}
