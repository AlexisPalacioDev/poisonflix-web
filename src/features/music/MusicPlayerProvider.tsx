import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useAuth } from '../../hooks/useAuth';
import { buildAudioStreamUrl } from '../../lib/domain/streamResolver';

// The one persistent audio surface for the whole app (Spotify-style). It lives
// ABOVE the router (App.tsx) so navigating between screens never unmounts the
// `<audio>` element — playback keeps going as the user browses. The element is
// hidden; the NowPlayingBar is its visible control surface.
//
// Slice 2 turns the single-track player into a real queue: play order, repeat,
// shuffle, seek, volume, and queue editing (jump/remove). Randomness never
// enters the reducer — the provider computes the (possibly shuffled) play order
// and hands it in via the action payload, so the reducer stays pure and every
// queue transition is deterministically testable.

export interface MusicTrack {
  itemId: string;
  title: string;
  artist: string | null;
  coverUrl: string | null;
  // Optional Jellyfin artist id, used by the full-screen mobile player to make
  // the artist name tappable (→ /musica/artist/:id). Purely presentational —
  // absent on tracks built from sources that don't carry it, in which case the
  // artist renders as plain text.
  artistId?: string | null;
  // Instant-play "preview" tracks (a search result not yet downloaded) carry a
  // ready-to-play URL — the /bff/music/stream proxy for their videoId — instead
  // of deriving one from a Jellyfin itemId. When present it wins over itemId.
  streamUrl?: string | null;
}

export type RepeatMode = 'off' | 'all' | 'one';

// Restarting (vs. skipping) the current track when PREV is pressed within this
// many seconds of the start — the familiar Spotify/iPod "back" behaviour.
export const PREV_RESTART_THRESHOLD = 3;

interface PlayerState {
  queue: MusicTrack[]; // display order — stable; edits (jump/remove) act on this
  order: number[]; // play order as queue indices; current is queue[order[pos]]
  pos: number; // cursor into `order`; -1 when nothing is loaded
  isPlaying: boolean;
  position: number; // seconds
  duration: number; // seconds
  volume: number; // 0..1
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  // Bumped whenever the audio element must jump to `position` (seek, prev
  // restart, repeat-one restart). A track change reloads `src` and resets
  // currentTime on its own, so those paths leave the nonce untouched.
  seekNonce: number;
}

type Action =
  | { type: 'PLAY_QUEUE'; tracks: MusicTrack[]; index: number; order: number[] }
  | { type: 'ENQUEUE'; tracks: MusicTrack[] }
  | { type: 'TOGGLE' }
  | { type: 'SET_PLAYING'; value: boolean }
  | { type: 'NEXT'; auto?: boolean }
  | { type: 'PREV' }
  | { type: 'JUMP_TO'; index: number } // queue index
  | { type: 'REMOVE'; index: number } // queue index
  | { type: 'SET_POSITION'; position: number }
  | { type: 'SEEK'; position: number }
  | { type: 'SET_DURATION'; duration: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'SET_MUTED'; value: boolean }
  | { type: 'SET_REPEAT'; mode: RepeatMode }
  | { type: 'SET_SHUFFLE'; value: boolean; order: number[] };

const initialState: PlayerState = {
  queue: [],
  order: [],
  pos: -1,
  isPlaying: false,
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  repeat: 'off',
  shuffle: false,
  seekNonce: 0,
};

/** [0, 1, 2, …, len-1] — the natural (un-shuffled) play order. */
export function naturalOrder(len: number): number[] {
  return Array.from({ length: len }, (_, i) => i);
}

/**
 * A permutation of [0, len) with `first` pinned to position 0 (Spotify keeps
 * the current track playing and shuffles the rest). `rng` is injectable so
 * tests can assert the permutation deterministically.
 */
export function shuffleOrder(len: number, first: number, rng: () => number = Math.random): number[] {
  const rest = naturalOrder(len).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first >= 0 && first < len ? [first, ...rest] : rest;
}

/** Queue index of the current track, or -1 when nothing is loaded. */
function currentIndexOf(state: PlayerState): number {
  return state.pos >= 0 ? (state.order[state.pos] ?? -1) : -1;
}

function reducer(state: PlayerState, action: Action): PlayerState {
  switch (action.type) {
    case 'PLAY_QUEUE': {
      if (action.tracks.length === 0) return state;
      const index = Math.min(Math.max(action.index, 0), action.tracks.length - 1);
      const pos = Math.max(action.order.indexOf(index), 0);
      return {
        ...state,
        queue: action.tracks,
        order: action.order,
        pos,
        isPlaying: true,
        position: 0,
        duration: 0,
      };
    }
    case 'ENQUEUE': {
      if (action.tracks.length === 0) return state;
      const startLen = state.queue.length;
      const queue = [...state.queue, ...action.tracks];
      const appended = action.tracks.map((_, i) => startLen + i);
      const order = [...state.order, ...appended];
      // Nothing was loaded: start playing the first enqueued track.
      if (state.pos < 0) {
        return { ...state, queue, order, pos: 0, isPlaying: true, position: 0, duration: 0 };
      }
      return { ...state, queue, order };
    }
    case 'TOGGLE':
      if (state.pos < 0) return state;
      return { ...state, isPlaying: !state.isPlaying };
    case 'SET_PLAYING':
      return { ...state, isPlaying: action.value };
    case 'NEXT': {
      if (state.pos < 0) return state;
      // Repeat-one only loops on auto-advance (track ended); pressing the Next
      // button still moves to the following track.
      if (action.auto && state.repeat === 'one') {
        return { ...state, position: 0, isPlaying: true, seekNonce: state.seekNonce + 1 };
      }
      if (state.pos + 1 < state.order.length) {
        return { ...state, pos: state.pos + 1, isPlaying: true, position: 0, duration: 0 };
      }
      // End of the play order.
      if (state.repeat === 'all' && state.order.length > 0) {
        return { ...state, pos: 0, isPlaying: true, position: 0, duration: 0 };
      }
      // No repeat: stop but keep the last track shown in the bar.
      return { ...state, isPlaying: false, position: 0 };
    }
    case 'PREV': {
      if (state.pos < 0) return state;
      // Restart the current track if we're past the threshold.
      if (state.position > PREV_RESTART_THRESHOLD) {
        return { ...state, position: 0, seekNonce: state.seekNonce + 1 };
      }
      if (state.pos > 0) {
        return { ...state, pos: state.pos - 1, isPlaying: true, position: 0, duration: 0 };
      }
      // At the first track: wrap to the last when repeating all, else restart.
      if (state.repeat === 'all' && state.order.length > 0) {
        return {
          ...state,
          pos: state.order.length - 1,
          isPlaying: true,
          position: 0,
          duration: 0,
        };
      }
      return { ...state, position: 0, seekNonce: state.seekNonce + 1 };
    }
    case 'JUMP_TO': {
      const pos = state.order.indexOf(action.index);
      if (pos < 0) return state;
      return { ...state, pos, isPlaying: true, position: 0, duration: 0 };
    }
    case 'REMOVE': {
      const { index } = action;
      if (index < 0 || index >= state.queue.length) return state;
      const currentIndex = currentIndexOf(state);
      const queue = state.queue.filter((_, i) => i !== index);
      // Re-index the play order: drop the removed queue index, shift the rest.
      const order = state.order
        .filter((qi) => qi !== index)
        .map((qi) => (qi > index ? qi - 1 : qi));

      if (queue.length === 0) {
        return {
          ...state,
          queue,
          order: [],
          pos: -1,
          isPlaying: false,
          position: 0,
          duration: 0,
        };
      }
      // Removing the current track: keep the cursor position so playback rolls
      // onto the track that shifted into this slot.
      if (index === currentIndex) {
        const pos = Math.min(state.pos, order.length - 1);
        return { ...state, queue, order, pos, position: 0, duration: 0 };
      }
      // Removing another track: keep the same track current by re-finding it.
      const nextCurrent = currentIndex > index ? currentIndex - 1 : currentIndex;
      const pos = order.indexOf(nextCurrent);
      return { ...state, queue, order, pos: pos < 0 ? state.pos : pos };
    }
    case 'SET_POSITION':
      return { ...state, position: action.position };
    case 'SEEK':
      return { ...state, position: action.position, seekNonce: state.seekNonce + 1 };
    case 'SET_DURATION':
      return { ...state, duration: action.duration };
    case 'SET_VOLUME':
      return { ...state, volume: Math.min(Math.max(action.volume, 0), 1), muted: false };
    case 'SET_MUTED':
      return { ...state, muted: action.value };
    case 'SET_REPEAT':
      return { ...state, repeat: action.mode };
    case 'SET_SHUFFLE': {
      const currentIndex = currentIndexOf(state);
      const pos = action.order.indexOf(currentIndex);
      return { ...state, shuffle: action.value, order: action.order, pos };
    }
    default:
      return state;
  }
}

export interface MusicPlayerContextValue {
  current: MusicTrack | null;
  queue: MusicTrack[];
  currentIndex: number; // index into `queue` of the current track, or -1
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  playNow: (tracks: MusicTrack[], startIndex?: number) => void;
  // Back-compat alias for playNow (Slice 1 call sites used `playQueue`).
  playQueue: (tracks: MusicTrack[], startIndex?: number) => void;
  enqueue: (tracks: MusicTrack | MusicTrack[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  removeFromQueue: (index: number) => void;
  jumpTo: (index: number) => void;
}

const MusicPlayerContext = createContext<MusicPlayerContextValue | undefined>(undefined);

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

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastTickRef = useRef(0);
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

  const currentIndex = currentIndexOf(state);
  const current = currentIndex >= 0 ? (state.queue[currentIndex] ?? null) : null;

  const currentItemId = current?.itemId ?? null;

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
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    if (srcUrlRef.current === currentSrc) return; // already loaded (e.g. by the gesture)
    srcUrlRef.current = currentSrc;
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
        const p = audio.play();
        if (p && typeof p.then === 'function') {
          p.then(() => audio.pause()).catch(() => {});
        }
      }
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('touchend', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
    };
  }, []);

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
    seekTo: (_seconds: number) => {},
    seekBy: (_offset: number) => {},
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
    seekTo: (seconds: number) => dispatch({ type: 'SEEK', position: seconds }),
    seekBy: (offset: number) => {
      const { position, duration } = stateRef.current;
      const target = position + offset;
      const clamped =
        duration > 0 ? Math.min(Math.max(target, 0), duration) : Math.max(target, 0);
      dispatch({ type: 'SEEK', position: clamped });
    },
  };

  // Register the OS action handlers once; forward each to the ref so it always
  // runs the newest closure. Unregister (null) on unmount.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
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
      ['seekbackward', (details) => mediaActionsRef.current.seekBy(-(details.seekOffset ?? 10))],
      ['seekforward', (details) => mediaActionsRef.current.seekBy(details.seekOffset ?? 10)],
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
      position: state.position,
      duration: state.duration,
      volume: state.volume,
      muted: state.muted,
      repeat: state.repeat,
      shuffle: state.shuffle,
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
  }, [state, current, currentIndex, runGesture]);

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
        onLoadedMetadata={(e) =>
          dispatch({ type: 'SET_DURATION', duration: e.currentTarget.duration || 0 })
        }
        onDurationChange={(e) =>
          dispatch({ type: 'SET_DURATION', duration: e.currentTarget.duration || 0 })
        }
        onEnded={() => dispatch({ type: 'NEXT', auto: true })}
      />
      {children}
    </MusicPlayerContext.Provider>
  );
}

export function useMusicPlayer(): MusicPlayerContextValue {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) {
    throw new Error('useMusicPlayer must be used within MusicPlayerProvider');
  }
  return ctx;
}

/**
 * Soft variant for the always-mounted NowPlayingBar: returns `null` instead of
 * throwing when no provider is present. The bar sits inside the router (in
 * AppLayout), so a full route-tree rendered without the top-level provider —
 * e.g. an isolated route-guard test — must not crash on it. Real usage always
 * has the provider (App.tsx), and MusicScreen keeps the strict `useMusicPlayer`.
 */
export function useOptionalMusicPlayer(): MusicPlayerContextValue | null {
  return useContext(MusicPlayerContext) ?? null;
}

// Re-exported for direct reducer testing of the queue transitions.
export { reducer as musicPlayerReducer, initialState as musicPlayerInitialState };
export type { PlayerState as MusicPlayerState, Action as MusicPlayerAction };
