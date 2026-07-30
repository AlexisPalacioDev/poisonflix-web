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

// Reliability change: the <audio> element becomes the source of truth for
// isPlaying/buffering via real media events, reconciled here — see design.md
// §A/§A2/§B and spec `music-playback-state` / `music-playback-diagnostics`.
//
// jsdom does NOT implement HTMLMediaElement.prototype.load and cannot
// reproduce real iOS promise-resolution ordering. Every test below drives the
// element through synthetic `fireEvent.*` calls and asserts the reducer/ref
// wiring that IS observable this way; it does not — and cannot — prove a real
// iOS device emits these events with this exact timing. That gap is
// deliberately left unclaimed rather than papered over with a misleading test.

const tracks: MusicTrack[] = [
  { itemId: 'a', title: 'Track A', artist: 'Artist A', coverUrl: null },
  { itemId: 'b', title: 'Track B', artist: 'Artist B', coverUrl: null },
];

let playSpy: PlayMock;

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

beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined) as PlayMock;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  clearRecordedFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSession();
});

describe('MusicPlayerProvider — playing-state reconciliation from media events', () => {
  it('an external pause event reconciles isPlaying to false', async () => {
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });
    expect(api.isPlaying).toBe(true);

    act(() => fireEvent.pause(audioEl()));
    expect(api.isPlaying).toBe(false);
  });

  it('a play event drives isPlaying to true from a false start', () => {
    renderProvider();
    expect(api.isPlaying).toBe(false);
    act(() => fireEvent.play(audioEl()));
    expect(api.isPlaying).toBe(true);
  });

  it('a playing event drives isPlaying to true from a false start', () => {
    renderProvider();
    expect(api.isPlaying).toBe(false);
    act(() => fireEvent.playing(audioEl()));
    expect(api.isPlaying).toBe(true);
  });
});

describe('MusicPlayerProvider — Safari ended-then-pause does not cancel auto-advance', () => {
  it('a pause fired right after ended does not block/undo the NEXT auto-advance', async () => {
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });
    expect(api.currentIndex).toBe(0);

    const audio = audioEl();
    // Safari quirk: fires `pause` right after `ended`, on the track that just
    // finished. `el.ended` stays true for that element until the next load.
    Object.defineProperty(audio, 'ended', { configurable: true, value: true });
    act(() => {
      fireEvent.ended(audio);
      fireEvent.pause(audio);
    });

    // The auto-advance NEXT (from `ended`) must stand: moved to track b and
    // still playing — a naive pause handler would flip isPlaying back to
    // false and appear to cancel the advance.
    expect(api.currentIndex).toBe(1);
    expect(api.isPlaying).toBe(true);
  });
});

describe('MusicPlayerProvider — unlock probe suppression', () => {
  // LIMITATION, stated rather than papered over: this proves the probe's pause does
  // not flip state, but it cannot discriminate `probeRef` from a (wrong)
  // `unlockedRef`-based guard, because `unlockedRef.current` is already true in this
  // setup by the time the probe fires. The source is correct — verified by reading
  // it — but reverting the guard would NOT turn this test red. Real iOS promise
  // ordering is not reproducible under jsdom either.
  it('the probe play()->pause() sequence does not flip isPlaying as a direct result', async () => {
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });
    act(() => api.toggle()); // pause via app state; track stays loaded (srcUrlRef set)
    expect(api.isPlaying).toBe(false);

    let resolveProbe!: () => void;
    const probePromise = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    playSpy.mockReturnValueOnce(probePromise);

    // First user-activation-eligible event anywhere in the document triggers
    // the belt-and-suspenders unlock probe (MusicPlayerProvider.tsx ~203-223).
    act(() => fireEvent.pointerDown(document));
    // Simulate the native `play` event the probe's play() call would produce.
    act(() => fireEvent.play(audioEl()));
    expect(api.isPlaying).toBe(false); // suppressed — not a real user play

    await act(async () => {
      resolveProbe();
      await probePromise;
    });
    // isPlaying was false when the probe resolved, so it calls audio.pause();
    // simulate the resulting native `pause` event, which closes the window.
    act(() => fireEvent.pause(audioEl()));
    expect(api.isPlaying).toBe(false); // still unaffected — no flip either way
  });

  // NOTE ON COVERAGE: `unlockedRef.current` is an internal ref never exposed
  // through the context, `window`, or any other test-observable surface, so
  // its transition to `true` cannot be asserted from a test without adding
  // test-only instrumentation the design does not call for. By inspection,
  // `unlockedRef.current = true` executes synchronously and unconditionally
  // inside the unlock() handler itself (before the probe's play() promise is
  // even created), so it is NOT gated on the probe's outcome — but that claim
  // is verified by reading the code, not by this suite. Real iOS
  // promise-resolution ordering for this exact sequence is equally not
  // assertable under jsdom and is not claimed here.
});

describe('MusicPlayerProvider — buffering distinct from paused, 600ms settle window', () => {
  it('a stall (waiting) does not report as paused and settles to buffering=true only after 600ms', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });
    expect(api.isPlaying).toBe(true);

    act(() => fireEvent.waiting(audioEl()));
    expect(api.isPlaying).toBe(true); // never flips on a stall
    expect(api.buffering).toBe(false); // not yet settled

    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(api.buffering).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1); // now at exactly 600ms
    });
    expect(api.buffering).toBe(true);
    expect(api.isPlaying).toBe(true); // still never flips
  });

  it('a stalled event also arms the settle window', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });

    act(() => fireEvent.stalled(audioEl()));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(api.buffering).toBe(true);
  });

  it('playing clears buffering immediately, with no delay', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });
    act(() => fireEvent.waiting(audioEl()));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(api.buffering).toBe(true);

    act(() => fireEvent.playing(audioEl()));
    expect(api.buffering).toBe(false); // cleared with zero timer advance
  });

  it('canplay also clears a pending/settled buffering flag', async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {
      api.playNow(tracks, 0);
    });
    act(() => fireEvent.waiting(audioEl()));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(api.buffering).toBe(true);

    act(() => fireEvent.canPlay(audioEl()));
    expect(api.buffering).toBe(false);
  });
});

describe('MusicPlayerProvider — duration mismatch diagnostics (security-sensitive)', () => {
  const mismatchTrack: MusicTrack = {
    itemId: 'dur-a',
    title: 'Long Track',
    artist: null,
    coverUrl: null,
    durationSeconds: 200,
  };

  it('SECURITY: never includes the api_key or the raw stream src in a reported detail', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([mismatchTrack], 0);
    });
    const audio = audioEl();
    const srcBefore = audio.getAttribute('src') ?? '';
    // Sanity: the src really does carry the secret this test defends against.
    expect(srcBefore).toContain('api_key=tok');

    Object.defineProperty(audio, 'duration', { configurable: true, value: 400 }); // 2x defect shape
    act(() => fireEvent.durationChange(audio));

    const failures = recordedFailures();
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) {
      const serialized = JSON.stringify(f.detail ?? null);
      expect(serialized).not.toContain('api_key');
      expect(serialized).not.toContain(srcBefore);
      expect(serialized.toLowerCase()).not.toContain('stream.m4a');
    }
  });

  it('reads seekable/buffered end through a null-returning guard instead of throwing', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([mismatchTrack], 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 400 });
    // jsdom's default TimeRanges are empty; `.end(0)` throws IndexSizeError on
    // an empty range, exercising exactly the guard this asserts.
    act(() => fireEvent.durationChange(audio));

    const last = recordedFailures().at(-1);
    const detail = last?.detail as Record<string, unknown> | undefined;
    expect(detail?.seekableEnd).toBeNull();
    expect(detail?.bufferedEnd).toBeNull();
  });

  it('reports at most once per track load even if durationchange repeats', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([mismatchTrack], 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 400 });
    const before = recordedFailures().length;

    act(() => fireEvent.durationChange(audio));
    const afterFirst = recordedFailures().length;
    act(() => fireEvent.durationChange(audio));
    const afterSecond = recordedFailures().length;

    expect(afterFirst - before).toBe(1);
    expect(afterSecond - afterFirst).toBe(0);
  });

  it('does not report when the duration is within tolerance', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([mismatchTrack], 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 202 }); // within 5% of 200
    const before = recordedFailures().length;
    act(() => fireEvent.durationChange(audio));
    expect(recordedFailures().length).toBe(before);
  });

  it('also reports on ended, not only on durationchange', async () => {
    // The spec requires BOTH triggers. `durationchange` catches a mismatch the
    // element declares up front; `ended` catches the shape the user actually
    // reported — audio that stops while the timer keeps running toward a phantom
    // end. Verify covering this change found `ended` had no test at all, even
    // though the wiring is one line, so a future refactor could silently drop the
    // trigger that matches the real-world symptom.
    renderProvider();
    await act(async () => {
      api.playNow([mismatchTrack], 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 400 });

    clearRecordedFailures();
    act(() => fireEvent.ended(audio));

    const reports = recordedFailures().filter(
      (f) => f.scope === 'music.player.durationMismatch',
    );
    expect(reports.length).toBe(1);
    expect(JSON.stringify(reports[0]?.detail)).not.toContain('api_key');
  });

  it('does NOT alter playback state as a side effect of reporting (no corrective behavior)', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([mismatchTrack], 0);
    });
    const audio = audioEl();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 400 });
    const before = {
      isPlaying: api.isPlaying,
      buffering: api.buffering,
      currentTime: audio.currentTime,
      src: audio.getAttribute('src'),
    };

    act(() => fireEvent.durationChange(audio));

    expect(api.isPlaying).toBe(before.isPlaying);
    expect(api.buffering).toBe(before.buffering);
    expect(audio.currentTime).toBe(before.currentTime);
    expect(audio.getAttribute('src')).toBe(before.src);
  });
});
