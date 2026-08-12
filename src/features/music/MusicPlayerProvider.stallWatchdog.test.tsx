import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { clearRecordedFailures, recordedFailures } from '../../lib/obs/report';

type PlayMock = MockInstance<(...args: never[]) => Promise<void>>;
type LoadMock = MockInstance<(...args: never[]) => void>;

// The stall watchdog: on a real device, an auto-advance that calls play() and
// then never reaches `playing` sat silent for 60-110s until the owner
// unlocked the phone by hand — 11 of 21 measured on-device auto-advances did
// exactly this, all with the same shape (`waiting` -> `stalled` -> nothing,
// readyState<=1). This suite asserts the recovery sequence: a first timeout
// retries load()+play() once; a second timeout (after the shorter grace
// window) gives up and skips to the next track. The "does NOT fire on a
// slow-but-live load" test matters as much as the "does fire" ones — a
// watchdog that kills a legitimately slow load would be worse than the bug.
//
// jsdom cannot reproduce a real network stall; these tests fake it by holding
// `readyState` at 0 (HAVE_NOTHING) and never firing `playing`, using fake
// timers to fast-forward past the watchdog's windows.

const STALL_WATCHDOG_MS = 40_000;
const STALL_RETRY_GRACE_MS = 15_000;

const TRACKS: MusicTrack[] = [
  { itemId: 'a', title: 'Track A', artist: 'Artist A', coverUrl: null },
  { itemId: 'b', title: 'Track B', artist: 'Artist B', coverUrl: null },
];

let playSpy: PlayMock;
let loadSpy: LoadMock;

let api: MusicPlayerContextValue;
function Capture() {
  api = useMusicPlayer();
  return null;
}

function renderProvider() {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <MusicPlayerProvider>
            <Capture />
          </MusicPlayerProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function audioEl(): HTMLAudioElement {
  return document.querySelector('audio') as HTMLAudioElement;
}

/** Simulates the traced hang shape: `play()` was called (so the element is
 *  NOT really paused) but `readyState` never got past HAVE_NOTHING (0) and
 *  `playing` never arrives. jsdom's mocked play()/pause() (see beforeEach)
 *  never flip the real `paused` getter the way a browser would, so it has to
 *  be forced here — the same reasoning the double-buffering suite uses for
 *  its own pause assertion. */
function pinStalledReadyState(audio: HTMLAudioElement) {
  Object.defineProperty(audio, 'readyState', { configurable: true, value: 0 });
  Object.defineProperty(audio, 'paused', { configurable: true, value: false });
}

beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined) as PlayMock;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}) as LoadMock;
  clearRecordedFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSession();
});

describe('MusicPlayerProvider — stall watchdog', () => {
  it('a stall that never reaches `playing` retries once, then skips to the next track', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    const audio = audioEl();
    pinStalledReadyState(audio);
    // Never fire `playing` — this is the traced hang: play() was called,
    // nothing else ever happened.

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS);
    });

    // First trip: retried via load()+play() on the SAME element.
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(api.currentIndex).toBe(0); // still on track A, mid-retry
    let reports = recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog');
    expect(reports.length).toBe(1);

    // Still stalled through the retry's grace window: give up and skip.
    act(() => {
      vi.advanceTimersByTime(STALL_RETRY_GRACE_MS);
    });

    expect(api.currentIndex).toBe(1); // advanced to track B
    reports = recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog');
    expect(reports.length).toBe(2);
  });

  it('recovers even when the element is fully buffered but play() never actually starts (e.g. a silently rejected/blocked play())', async () => {
    // Regression test for a gap found while documenting an unrelated,
    // unverified risk (whether iOS unlocks a NEVER-gestured second element
    // for a non-gesture `play()` call): an earlier version of this watchdog
    // treated `readyState > 1` as proof of health, which is wrong for a
    // PROMOTED element specifically — it can be fully preloaded (readyState
    // 4) while its `play()` was silently rejected, producing neither
    // `playing` nor `error`. Only "did a `playing` event ever arrive"
    // (via `clearStallWatchdog`) is a valid health signal; `readyState`
    // alone is not, because double buffering means the element can be fully
    // buffered before it has ever been asked to play at all.
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
    Object.defineProperty(audio, 'paused', { configurable: true, value: true });
    // No `playing`, `pause`, or `error` ever fires — exactly what a silently
    // rejected play() promise looks like from the outside.

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS);
    });

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('a real user pause cancels the pending watchdog — no forced retry/skip the user never asked for', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    const audio = audioEl();
    pinStalledReadyState(audio);

    // The user pauses mid-load, before the watchdog would have fired.
    Object.defineProperty(audio, 'paused', { configurable: true, value: true });
    act(() => fireEvent.pause(audio));

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS + STALL_RETRY_GRACE_MS);
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(api.currentIndex).toBe(0);
    expect(recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog')).toHaveLength(
      0,
    );
  });

  it('does NOT fire on a slow-but-live load that eventually reaches `playing`', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    const audio = audioEl();
    pinStalledReadyState(audio);

    // 35s — inside the measured "degraded but alive" range (18-35s) — then
    // the track actually starts.
    act(() => {
      vi.advanceTimersByTime(35_000);
    });
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
    act(() => fireEvent.playing(audio));

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS);
    });

    // The watchdog for THIS attempt must not still fire after the track came
    // alive — no retry, no skip.
    expect(loadSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(api.currentIndex).toBe(0);
    expect(recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog')).toHaveLength(
      0,
    );
  });

  it('a healthy transition (playing arrives immediately) never arms a retry', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
    act(() => fireEvent.playing(audio));

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS + STALL_RETRY_GRACE_MS);
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog')).toHaveLength(
      0,
    );
  });

  it('stops instead of endlessly skipping once the consecutive-failure breaker trips', async () => {
    // Same breaker `onError` uses (MAX_CONSECUTIVE_AUDIO_ERRORS = 3). Five
    // tracks queued so there is still unplayed queue left when the breaker
    // trips — proving it stopped BECAUSE of the breaker, not because it ran
    // out of tracks to skip to.
    const longQueue: MusicTrack[] = [
      { itemId: 'a', title: 'A', artist: null, coverUrl: null },
      { itemId: 'b', title: 'B', artist: null, coverUrl: null },
      { itemId: 'c', title: 'C', artist: null, coverUrl: null },
      { itemId: 'd', title: 'D', artist: null, coverUrl: null },
      { itemId: 'e', title: 'E', artist: null, coverUrl: null },
    ];
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(longQueue, 0);
    });

    for (let i = 0; i < 3; i++) {
      pinStalledReadyState(audioEl());
      act(() => {
        vi.advanceTimersByTime(STALL_WATCHDOG_MS);
        vi.advanceTimersByTime(STALL_RETRY_GRACE_MS);
      });
    }

    expect(api.isPlaying).toBe(false);
    // Stopped on the 3rd track (index 2) — d and e were never reached.
    expect(api.currentIndex).toBe(2);
  });

  it('the breaker still trips when each stall reaches HAVE_METADATA (readyState 1), not just HAVE_NOTHING (0)', async () => {
    // Regression test for a bug adversarial review caught: the traced hangs
    // sat at "readyState 0-1" (the provider's own watchdog comment says so),
    // but `handleLoadedMetadata` used to reset `consecutiveErrorsRef` to 0 —
    // and `readyState === 1` means `loadedmetadata` already fired. The first
    // version of this suite only ever pinned `readyState` to 0, which is the
    // one value where that reset path could never have fired, so it was
    // structurally blind to a real hang that gets as far as metadata and then
    // sticks there — which the fix moved the reset to `playing` to close.
    const longQueue: MusicTrack[] = [
      { itemId: 'a', title: 'A', artist: null, coverUrl: null },
      { itemId: 'b', title: 'B', artist: null, coverUrl: null },
      { itemId: 'c', title: 'C', artist: null, coverUrl: null },
      { itemId: 'd', title: 'D', artist: null, coverUrl: null },
      { itemId: 'e', title: 'E', artist: null, coverUrl: null },
    ];
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(longQueue, 0);
    });

    for (let i = 0; i < 3; i++) {
      const audio = audioEl();
      Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
      Object.defineProperty(audio, 'paused', { configurable: true, value: false });
      // The traced shape reaches metadata before it sticks — fire the real
      // event so any reset tied to it would (wrongly) fire too.
      act(() => fireEvent.loadedMetadata(audio));
      act(() => {
        vi.advanceTimersByTime(STALL_WATCHDOG_MS);
        vi.advanceTimersByTime(STALL_RETRY_GRACE_MS);
      });
    }

    expect(api.isPlaying).toBe(false);
    expect(api.currentIndex).toBe(2); // stopped by the breaker, not the end of the queue
  });
});

describe('MusicPlayerProvider — stall watchdog lifecycle (armed/cleared by state, not just by playImperative)', () => {
  // Regression tests for a second round of adversarial review: `armStallWatchdog`
  // used to be invoked ONLY from `playImperative`, so any transition that
  // changes what should be playing WITHOUT going through it (queue mutations
  // dispatched directly from context methods, e.g. `removeFromQueue`) left a
  // stale watchdog running — see the lifecycle effect's own comment in
  // MusicPlayerProvider.tsx for the two concrete failure shapes this closes.

  it('clears the watchdog when the queue is emptied out from under a pending stall', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow([TRACKS[0]], 0);
    });
    pinStalledReadyState(audioEl());

    await act(async () => {
      api.removeFromQueue(0);
    });
    expect(api.currentIndex).toBe(-1);

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS + STALL_RETRY_GRACE_MS);
    });

    // Nothing left to recover — a src-less element must not get a forced
    // load()+play(), and no false report should name a track that no longer
    // exists.
    expect(loadSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog')).toHaveLength(
      0,
    );
  });

  it('re-arms fresh (correct track, full timeout budget) when removing the CURRENT track shifts to a new one', async () => {
    const three: MusicTrack[] = [
      { itemId: 'a', title: 'A', artist: null, coverUrl: null },
      { itemId: 'b', title: 'B', artist: null, coverUrl: null },
      { itemId: 'c', title: 'C', artist: null, coverUrl: null },
    ];
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(three, 0);
    });
    pinStalledReadyState(audioEl());

    // Most of the way through A's watchdog window when the user removes it —
    // the reducer's REMOVE branch reassigns `current` to B without touching
    // `isPlaying` and without going through `playImperative`.
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS - 5_000);
    });
    await act(async () => {
      api.removeFromQueue(0);
    });
    expect(api.currentIndex).toBe(0); // B shifted into slot 0
    pinStalledReadyState(audioEl());

    clearRecordedFailures();
    playSpy.mockClear();
    loadSpy.mockClear();

    // Only 4s left of the OLD track's budget — if the stale watchdog were
    // still ticking, it would fire here. It must not.
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(recordedFailures()).toHaveLength(0);

    // The full fresh window for the NEW current track (B) has now elapsed.
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS - 4_000 + 1_000);
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    const reports = recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog');
    expect(reports.length).toBe(1);
    // The report must name the track actually stalled (B), not the one that
    // was removed (A).
    expect((reports[0]?.detail as { itemId?: string })?.itemId).toBe('b');
  });

  it('clears a pending watchdog when the app-level intent to play flips false, even if the element never emits a `pause` event', async () => {
    // Per spec, `pause()` only fires a `pause` event if `paused` transitions
    // from false to true. If a play() attempt was silently rejected, `paused`
    // may already be `true` from the start — a later `audio.pause()` call is
    // then a no-op with NO event, so a handler keyed only on that DOM event
    // can miss the user's own pause entirely. `state.isPlaying` going false
    // via `dispatch` is unconditional and must catch this regardless.
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    const audio = audioEl();
    pinStalledReadyState(audio);
    Object.defineProperty(audio, 'paused', { configurable: true, value: true }); // never actually started

    await act(async () => {
      api.toggle(); // user pauses — no native `pause` event will fire
    });
    expect(api.isPlaying).toBe(false);

    playSpy.mockClear();
    loadSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS + STALL_RETRY_GRACE_MS);
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog')).toHaveLength(
      0,
    );
  });
});

describe('MusicPlayerProvider — the stall watchdog covers repeat-one too', () => {
  it('arms a watchdog for a repeat-one loop that never reaches `playing`', async () => {
    // Repeat-one is the one path that does NOT go through `playImperative`
    // (the only other place that arms the watchdog), and the effect that would
    // otherwise re-arm is keyed on `[isPlaying, currentItemId]` — neither of
    // which changes when a track loops onto itself. `handleEnded` clears the
    // watchdog on its way in, so before this fix a repeat-one loop that hung
    // had no detection at all.
    //
    // That is the worst possible place for a blind spot: repeat-one was made
    // synchronous by this rewrite precisely BECAUSE it was the path dying on a
    // locked screen.
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(TRACKS, 0);
    });
    act(() => api.setRepeat('one'));

    const audio = audioEl();
    pinStalledReadyState(audio);
    audio.dispatchEvent(new Event('ended')); // loops back to the same track
    await act(async () => {});
    expect(api.currentIndex).toBe(0); // looped, not advanced

    loadSpy.mockClear();
    playSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS);
    });

    // The watchdog noticed: a retry happened and it was reported.
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(
      recordedFailures().filter((f) => f.scope === 'music.player.stallWatchdog').length,
    ).toBe(1);
  });
});
