import { createContext, useContext } from 'react';

// The music player's state machine and context handle, with no component in
// sight. Split out of MusicPlayerProvider.tsx because React Fast Refresh only
// hot-reloads a module that exports components *and nothing else*: while these
// lived beside the provider, every edit to the player remounted the tree and
// dropped whatever was playing.
//
// The reducer being pure and component-free is also what lets the queue
// transitions be tested directly, with no React at all.

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
  // The YouTube videoId this track came from, when known (search / radio hits).
  // Autoplay seeds the next radio from it; library tracks leave it undefined and
  // the worker reverses their itemId instead.
  videoId?: string | null;
  // Known length in seconds, when the source already told us (a search hit
  // carries it). Seeds the player's duration until the audio element reports
  // its own — a streamed track can be slow to expose one, and a progress bar
  // with no scale renders as permanently finished.
  durationSeconds?: number | null;
  // Instant-play "preview" tracks (a search result not yet downloaded) carry a
  // ready-to-play URL — the /bff/music/stream proxy for their videoId — instead
  // of deriving one from a Jellyfin itemId. When present it wins over itemId.
  streamUrl?: string | null;
}

export type RepeatMode = 'off' | 'all' | 'one';

// Restarting (vs. skipping) the current track when PREV is pressed within this
// many seconds of the start — the familiar Spotify/iPod "back" behaviour.
export const PREV_RESTART_THRESHOLD = 3;

export interface PlayerState {
  queue: MusicTrack[]; // display order — stable; edits (jump/remove) act on this
  order: number[]; // play order as queue indices; current is queue[order[pos]]
  pos: number; // cursor into `order`; -1 when nothing is loaded
  isPlaying: boolean;
  // Raw stall signal from `waiting`/`stalled`, armed by the provider's settle
  // timer and cleared on `playing`/`canplay`. Never read directly by the UI —
  // see `visibleBuffering` below for why.
  buffering: boolean;
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

export type Action =
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
  | { type: 'SET_SHUFFLE'; value: boolean; order: number[] }
  // Reconciles state from a real <audio> element event (play/playing/pause/
  // waiting/stalled/canplay). A single identity-returning patch action rather
  // than one action per event — see design.md §A: five per-event actions
  // would bloat the reducer switch for no benefit, and reusing SET_PLAYING
  // would conflate *intent* (a gesture) with *observation* (the element told
  // us), which loses the identity-return no-render-churn guarantee.
  | { type: 'SYNC_MEDIA'; playing?: boolean; buffering?: boolean };

export const initialState: PlayerState = {
  queue: [],
  order: [],
  pos: -1,
  isPlaying: false,
  buffering: false,
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
export function currentIndexOf(state: PlayerState): number {
  return state.pos >= 0 ? (state.order[state.pos] ?? -1) : -1;
}

export function reducer(state: PlayerState, action: Action): PlayerState {
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
    case 'SET_DURATION': {
      // The element reports 0 before metadata lands, and Infinity for a stream
      // whose length it cannot work out. Neither may wipe a length we were
      // handed up front, or the bar would drop back to "no scale" mid-play.
      if (!Number.isFinite(action.duration) || action.duration <= 0) return state;
      return { ...state, duration: action.duration };
    }
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
    case 'SYNC_MEDIA': {
      const playing = action.playing ?? state.isPlaying;
      const buffering = action.buffering ?? state.buffering;
      if (playing === state.isPlaying && buffering === state.buffering) return state;
      return { ...state, isPlaying: playing, buffering };
    }
    default:
      return state;
  }
}

// Milliseconds a `waiting`/`stalled` signal must persist before the UI shows
// it. At the stream's measured throughput (~32 KB/s vs a 129 kbps track)
// sub-window underruns are routine and inaudible; asserting them anyway would
// give the spinner a habit of lying. See design.md §B — this value is an
// explicit override of the spec's provisional 250ms figure.
export const BUFFERING_SETTLE_MS = 600;

/**
 * The buffering flag actually shown to the UI: a stuck `buffering` flag can
 * never outlive playback, without touching any of the 11 track-change reducer
 * branches above (each of which already resets `isPlaying` where it matters).
 * Pure and exported so this rule is asserted directly, with no React and no
 * dependency on which branch last touched `buffering`.
 */
export function visibleBuffering(state: PlayerState): boolean {
  return state.buffering && state.isPlaying;
}

/**
 * True when the <audio> element's reported `duration` disagrees with the
 * track's already-known `durationSeconds` by more than a tolerance band: 5%
 * (tolerates remux drift; the unidentified 2x-duration defect is 100% off) or
 * a 2s floor (covers short tracks where 5% is too tight to mean anything).
 * Diagnostic-only — see MusicPlayerProvider's durationchange/ended wiring.
 * Never true for a non-finite/zero/negative/missing value on either side.
 */
export function durationMismatch(
  elementDuration: number,
  trackDuration?: number | null,
): boolean {
  if (!Number.isFinite(elementDuration) || elementDuration <= 0) return false;
  if (
    trackDuration == null ||
    !Number.isFinite(trackDuration) ||
    trackDuration <= 0
  ) {
    return false;
  }
  const tolerance = Math.max(2, trackDuration * 0.05);
  return Math.abs(elementDuration - trackDuration) > tolerance;
}

/**
 * True when the track must advance from a native `timeupdate` tick instead of
 * waiting for `ended` — the fix for the iOS fMP4 defect that duplicates the
 * element's reported duration (see `durationMismatch`'s docstring): audio
 * genuinely stops at the real length, but the element believes it's ~2x that,
 * so `ended` never arrives (or arrives ~2x too late).
 *
 * Deliberately the AND of three signals, not any one alone:
 *  1. `durationMismatch` — there IS a real, tolerance-exceeding disagreement
 *     between what the element reports and the track's known real length.
 *  2. The element's duration is at least `FORCED_ADVANCE_MIN_RATIO` times the
 *     known length, i.e. the disagreement has the SHAPE of the doubling
 *     defect rather than merely being some disagreement.
 *  3. `currentTime` has reached that known real length — playback has actually
 *     gotten to where the track should be over.
 *
 * (2) is what keeps this from truncating music. `durationMismatch` is a
 * symmetric 5%/2s band, so it also fires when metadata is simply a little off —
 * and metadata that undershoots by more than 5% is common. Without the ratio
 * check, a track whose metadata says 3:00 but which really runs 3:20 would be
 * cut 20 seconds early, every time. The doubling defect is ~100% off, so a 1.5x
 * floor separates the two with a wide margin in both directions: a track has to
 * be at least half again as long as advertised before we stop trusting `ended`.
 *
 * `durationMismatch` already guards every degenerate input (missing/non-finite/
 * zero/negative on either side), so the checks below can assume real numbers.
 */
const FORCED_ADVANCE_MIN_RATIO = 1.5;

export function shouldForceAdvance(
  elementDuration: number,
  trackDurationSeconds: number | null | undefined,
  currentTime: number,
): boolean {
  if (!durationMismatch(elementDuration, trackDurationSeconds)) return false;
  // `durationMismatch` returning true already guarantees `trackDurationSeconds`
  // is a finite, positive number here.
  const known = trackDurationSeconds as number;
  if (elementDuration < known * FORCED_ADVANCE_MIN_RATIO) return false;
  return currentTime >= known;
}

export interface MusicPlayerContextValue {
  current: MusicTrack | null;
  queue: MusicTrack[];
  currentIndex: number; // index into `queue` of the current track, or -1
  isPlaying: boolean;
  // The stall indicator actually safe to show — see `visibleBuffering`.
  buffering: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  // False when the current track is the last in play order — the cue autoplay
  // watches to extend the queue before the music runs out.
  hasNext: boolean;
  // Persisted: when on, a finished queue continues into a radio of related
  // tracks (see `useAutoplayRadio`) instead of going silent.
  autoplay: boolean;
  setAutoplay: (value: boolean) => void;
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

export const MusicPlayerContext = createContext<MusicPlayerContextValue | undefined>(undefined);

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
