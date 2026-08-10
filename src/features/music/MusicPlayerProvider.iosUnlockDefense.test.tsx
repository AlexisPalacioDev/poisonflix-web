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
type PauseMock = MockInstance<(...args: never[]) => void>;

// Double buffering's unresolved risk (see MusicPlayerProvider.tsx, the
// comment above the belt-and-suspenders unlock effect and above
// `fallbackFromFailedPromotion`): it is unknown from here whether iOS scopes
// its autoplay unlock PER-ELEMENT or PER-DOCUMENT/session. The preload
// element's first-ever `play()` always used to run from an `ended` handler —
// never from a user gesture. If the unlock is per-element, that call is
// rejected silently, and double buffering would turn TODAY's 10/21 successful
// locked-screen transitions into 0/21 instead of improving on them.
//
// Two independent defenses target that risk:
//   1. PREVENTION — also probe (play()->pause()) the preload element during
//      the very first user gesture, muted, so it gets its own shot at being
//      unlocked the same way the active element already does.
//   2. MITIGATION — if a promoted element's play() rejects anyway, fall back
//      to the original (gesture-backed) element instead of silence, and
//      report it so a real device trace can finally tell us whether the
//      per-element theory is true.
//
// jsdom cannot reproduce iOS's actual autoplay policy, so none of this proves
// either defense works on a real phone — only that the wiring behaves as
// designed under a controllable, mocked `play()`. A first adversarial pass
// over this exact file found that a mocked `play()` hides a real Chromium
// behaviour (a src-less `play()` inside a gesture stays PENDING forever,
// never resolving or rejecting on its own) and two real races where a
// pending promotion's rejection lands after something ELSE already moved
// playback on. The tests below that specifically target those findings say
// so in their own description.

const PREVIEW_A: MusicTrack = {
  itemId: 'vid-a',
  title: 'Preview A',
  artist: 'Artist A',
  coverUrl: null,
  videoId: 'vid-a',
  streamUrl: '/bff/music/stream?videoId=vid-a',
};
const PREVIEW_B: MusicTrack = {
  itemId: 'vid-b',
  title: 'Preview B',
  artist: 'Artist B',
  coverUrl: null,
  videoId: 'vid-b',
  streamUrl: '/bff/music/stream?videoId=vid-b',
};
const PREVIEW_C: MusicTrack = {
  itemId: 'vid-c',
  title: 'Preview C',
  artist: 'Artist C',
  coverUrl: null,
  videoId: 'vid-c',
  streamUrl: '/bff/music/stream?videoId=vid-c',
};

// No `streamUrl` -> never preloaded (see MusicPlayerProvider's preload
// effect docstring). Used for the unlock-probe tests, which only care about
// the ACTIVE element having something loaded, not about a real preload.
const LIBRARY_A: MusicTrack = { itemId: 'lib-a', title: 'Library A', artist: 'A', coverUrl: null };
const LIBRARY_B: MusicTrack = { itemId: 'lib-b', title: 'Library B', artist: 'B', coverUrl: null };

let playSpy: PlayMock;
let pauseSpy: PauseMock;

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

/** Both physical <audio> elements, in DOM (JSX) order. */
function audios(): HTMLAudioElement[] {
  return Array.from(document.querySelectorAll('audio'));
}

function endedRaw(el: HTMLAudioElement) {
  el.dispatchEvent(new Event('ended'));
}

/** Instruments an element's `src` setter so tests can count (re)assignments. */
function trackSrcAssignments(audio: HTMLAudioElement): { srcSets: string[] } {
  const proto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
  const srcSets: string[] = [];
  Object.defineProperty(audio, 'src', {
    configurable: true,
    get() {
      return proto.get!.call(this);
    },
    set(v: string) {
      srcSets.push(v);
      proto.set!.call(this, v);
    },
  });
  return { srcSets };
}

beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined) as PlayMock;
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}) as PauseMock;
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  clearRecordedFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSession();
});

describe('MusicPlayerProvider — PREVENTION: unlock probe reaches both elements', () => {
  it('the first-gesture probe calls play() on BOTH elements, active before preload', () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle()); // pause; the active element stays loaded (srcUrlRef set)
    expect(api.isPlaying).toBe(false);

    const [active, preload] = audios();
    playSpy.mockClear();

    act(() => fireEvent.pointerDown(document));

    // Both got a play() call from the SAME gesture...
    const activeCallIndex = playSpy.mock.instances.indexOf(active);
    const preloadCallIndex = playSpy.mock.instances.indexOf(preload);
    expect(activeCallIndex).toBeGreaterThanOrEqual(0);
    expect(preloadCallIndex).toBeGreaterThanOrEqual(0);
    // ...and specifically in that order: the active element's own probe/play()
    // runs BEFORE the preload element is ever touched, so if this same
    // gesture is also what starts real playback, audio focus has already
    // been requested by the active element first. This is documented as the
    // best available ordering, not a proven guarantee (see the comment above
    // the preload probe in MusicPlayerProvider.tsx) — this test only pins
    // down that the ORDER is what the code claims, not that iOS honours it.
    expect(activeCallIndex).toBeLessThan(preloadCallIndex);
  });

  it('mutes the preload element BEFORE calling play() on it, not after', () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle());
    const [, preload] = audios();
    expect(preload.muted).toBe(false); // sanity: not muted before the probe

    let mutedAtCallTime: boolean | undefined;
    playSpy.mockImplementation(function (this: HTMLAudioElement) {
      if (this === preload) {
        // Captured synchronously, INSIDE the mock, at the exact moment
        // play() is invoked — the only way to prove the mute happened
        // before play() rather than merely before the next assertion line.
        mutedAtCallTime = this.muted;
      }
      return Promise.resolve(undefined);
    });

    act(() => fireEvent.pointerDown(document));

    expect(mutedAtCallTime).toBe(true);
  });

  it('restores the preload element mute state once the probe settles, and always pauses it', async () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle());
    const [, preload] = audios();

    await act(async () => {
      fireEvent.pointerDown(document);
    });

    expect(preload.muted).toBe(false); // restored to its pre-probe value
    expect(pauseSpy.mock.instances).toContain(preload); // play()->pause(), never left playing
  });

  it('a play() that never settles (measured on real Chromium for a src-less element) is force-cleaned by the safety timeout', () => {
    // Adversarial review measured this directly: calling play() on an
    // <audio> with NO source, from inside a gesture, stays PENDING forever
    // in Chromium — it never resolves or rejects on its own. Without a
    // safety net, that would leave the preload element muted and (per spec)
    // still "wanting to play" for the rest of the session. This is exactly
    // the case the belt-and-suspenders 3s timeout exists for.
    vi.useFakeTimers();
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0)); // no streamUrl -> preload has no src
    act(() => api.toggle());
    const [, preload] = audios();
    expect(preload.hasAttribute('src')).toBe(false);

    // A promise that never settles — the measured real-world behaviour.
    playSpy.mockImplementation(function (this: HTMLAudioElement) {
      if (this === preload) return new Promise<void>(() => {});
      return Promise.resolve(undefined);
    });

    act(() => fireEvent.pointerDown(document));
    expect(preload.muted).toBe(true); // still pending, still muted

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(preload.muted).toBe(false); // force-restored, not stuck forever
    expect(pauseSpy.mock.instances).toContain(preload);
  });

  it('a rejected preload probe (real autoplay block) does not dirty app state, and IS reported', async () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle());
    expect(api.isPlaying).toBe(false);

    const [, preload] = audios();
    playSpy.mockImplementation(function (this: HTMLAudioElement) {
      if (this === preload) {
        return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      fireEvent.pointerDown(document);
    });

    // Nothing about app-level playback state moved — the probe's own
    // play/pause events are inert no-ops (gated on `audioRef.current`), and a
    // rejection must not touch any of it either.
    expect(api.isPlaying).toBe(false);
    expect(preload.muted).toBe(false); // still restored, not left stuck muted
    const report = recordedFailures().find((f) => f.scope === 'music.player.preloadUnlockProbe');
    expect(report).toBeDefined();
    expect(report?.detail).toMatchObject({ errorName: 'NotAllowedError' });
  });

  it('an AbortError from the probe (self-inflicted, e.g. interrupted by a real load) is NOT reported', async () => {
    // AbortError here means something ELSE interrupted this still-pending
    // play() — most commonly the ordinary preload effect assigning a real
    // `src` + calling `.load()` moments later, or this probe's own safety
    // timeout pausing it. It is expected noise, not autoplay-block evidence,
    // and reporting it as such would drown out the one signal this exists to
    // capture (see MusicPlayerProvider.tsx's `preloadUnlockProbe` comment).
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle());
    const [, preload] = audios();
    playSpy.mockImplementation(function (this: HTMLAudioElement) {
      if (this === preload) {
        return Promise.reject(new DOMException('interrupted', 'AbortError'));
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      fireEvent.pointerDown(document);
    });

    expect(preload.muted).toBe(false); // still restored despite the rejection
    expect(recordedFailures().some((f) => f.scope === 'music.player.preloadUnlockProbe')).toBe(
      false,
    );
  });
});

describe('MusicPlayerProvider — MITIGATION: fallback when a promoted play() rejects', () => {
  it('falls back to the original element and keeps playing when the promoted play() rejects', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const [first, second] = audios();
    expect(second.getAttribute('src')).toContain('videoId=vid-b'); // B preloaded onto the second element

    const { srcSets: firstSrcSets } = trackSrcAssignments(first);
    // The NEXT play() call after `ended` is the promotion's own — see
    // MusicPlayerProvider.tsx's `playImperative`: nothing else calls play()
    // in between `ended` and it.
    playSpy.mockImplementationOnce(() =>
      Promise.reject(new DOMException('not allowed', 'NotAllowedError')),
    );
    playSpy.mockClear(); // isolate the calls this test actually asserts on

    await act(async () => {
      endedRaw(first);
    });

    // The queue still advanced (the reducer dispatch does not depend on
    // whether play() succeeds)...
    expect(api.currentIndex).toBe(1);
    expect(api.isPlaying).toBe(true);
    // ...and the ORIGINAL element — the one that actually received a user
    // gesture this session — was given track B's URL and asked to play,
    // exactly the pre-double-buffering behaviour that is measured at 10/21
    // rather than 0/21.
    expect(firstSrcSets.some((s) => s.includes('videoId=vid-b'))).toBe(true);
    // Cleared right before `endedRaw`, so this can only be true if the
    // fallback itself called play() on `first` — not a leftover from the
    // initial `playNow`.
    expect(playSpy.mock.instances).toContain(first);
  });

  it('reports the rejected promotion via reportFailure with its own scope', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const [first] = audios();
    playSpy.mockImplementationOnce(() =>
      Promise.reject(new DOMException('not allowed', 'NotAllowedError')),
    );

    await act(async () => {
      endedRaw(first);
    });

    const report = recordedFailures().find((f) => f.scope === 'music.player.promotionPlayRejected');
    expect(report).toBeDefined();
    expect(report?.detail).toMatchObject({ itemId: 'vid-b', videoId: 'vid-b' });
  });

  it('a promotion that succeeds normally never triggers the fallback reload or its report', async () => {
    // Three tracks so `first` has a legitimate reason to be reloaded after
    // the promotion: it becomes the new PRELOADER for C, and the ordinary
    // preload-cycle effect calls `.load()` on whichever element holds that
    // role, regardless of whether a fallback ever ran. That means "was
    // `.load()` called on `first`" can't tell the two apart — the actual
    // fallback signature is reassigning track B's OWN url onto it, which
    // only a rejected promotion would ever do.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    const [first, second] = audios();
    expect(second.getAttribute('src')).toContain('videoId=vid-b');
    const { srcSets: firstSrcSets } = trackSrcAssignments(first);

    await act(async () => {
      endedRaw(first);
    });

    expect(api.currentIndex).toBe(1);
    // `first` legitimately gets reused as the new preloader for C — that is
    // the feature working as designed. What must never happen is the
    // fallback reassigning B's url onto it, which only fires on a rejection.
    expect(firstSrcSets.some((s) => s.includes('videoId=vid-b'))).toBe(false);
    expect(recordedFailures().some((f) => f.scope === 'music.player.promotionPlayRejected')).toBe(
      false,
    );
  });

  it('an AbortError on the promoted play() (e.g. the watchdog aborting its own pending retry) does NOT trigger the fallback', async () => {
    // A second adversarial pass measured this concretely: the stall
    // watchdog's own stage-0 retry calls `audio.load()` on the SAME element
    // whose promoted `play()` is still pending — per spec, that ABORTS the
    // pending play() with `AbortError`. The identity guard inside
    // `fallbackFromFailedPromotion` does NOT catch this (neither
    // `audioRef.current` nor `srcUrlRef.current` change when the watchdog
    // retries on the same element), so without filtering by error name the
    // fallback would fire for a rejection this file caused itself —
    // reporting fake "promotionPlayRejected" evidence and stepping on the
    // watchdog's own retry mid-flight. This is filtered at the call site in
    // `playImperative`, not inside `fallbackFromFailedPromotion` itself.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const [first] = audios();
    playSpy.mockImplementationOnce(() =>
      Promise.reject(new DOMException('interrupted', 'AbortError')),
    );

    await act(async () => {
      endedRaw(first);
    });

    expect(recordedFailures().some((f) => f.scope === 'music.player.promotionPlayRejected')).toBe(
      false,
    );
  });

  // NOTE ON COVERAGE: `fallbackFromFailedPromotion` also calls
  // `armStallWatchdog` for its own play() attempt, so it never inherits
  // whatever stage/timer the INTERRUPTED attempt's watchdog was on. This is
  // not independently testable from here the way the rest of this suite is:
  // by the time a genuine (non-Abort) rejection reaches the fallback, the
  // declarative effect that re-arms the watchdog off `currentItemId`
  // (MusicPlayerProvider.tsx, the effect keyed on `[state.isPlaying,
  // currentItemId, ...]`) has ALREADY re-armed a full fresh budget for the
  // same key, for the unrelated reason that promoting to this track changed
  // `currentItemId` moments earlier — so a test cannot observe the
  // difference between "the explicit call worked" and "the state effect
  // would have fixed it anyway" without instrumenting internals the design
  // does not expose. Verified by reading the code, not by a passing test.

  it('a STALE promotion rejection — superseded by a newer gesture before it settles — does not corrupt playback', async () => {
    // Adversarial review found this race: `fallbackFromFailedPromotion` runs
    // from an async `.catch`, and something else (a manual skip, another
    // promotion) can move `audioRef.current`/`srcUrlRef` again before that
    // rejection is delivered. Acting on it anyway would silently move a
    // NEWER, already-correct playback state backwards. The guard inside
    // `fallbackFromFailedPromotion` must make this a pure no-op.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    const [elA] = audios();

    let rejectFirstPromotion!: (err: unknown) => void;
    const pendingFirstPromotion = new Promise<void>((_resolve, reject) => {
      rejectFirstPromotion = reject;
    });
    // The FIRST play() call after `ended` is B's own promotion attempt —
    // leave it pending, exactly like an in-flight promise still waiting on
    // iOS's answer.
    playSpy.mockImplementationOnce(() => pendingFirstPromotion);

    await act(async () => {
      endedRaw(elA); // promotes B; its play() is now pending, not yet settled
    });
    expect(api.currentIndex).toBe(1);

    // A newer gesture supersedes it before the pending promise ever settles.
    await act(async () => {
      api.next(); // -> C
    });
    const indexAfterNext = api.currentIndex;
    expect(indexAfterNext).toBe(2);
    clearRecordedFailures();

    // NOW the stale promise from the FIRST (B) promotion finally rejects.
    await act(async () => {
      rejectFirstPromotion(new DOMException('not allowed', 'NotAllowedError'));
      await pendingFirstPromotion.catch(() => {});
    });

    // Must be a pure no-op: no fallback fired for it (it would have
    // clobbered whatever `next()` already put in place), and the queue
    // position `next()` already advanced to is untouched.
    expect(recordedFailures().some((f) => f.scope === 'music.player.promotionPlayRejected')).toBe(
      false,
    );
    expect(api.currentIndex).toBe(indexAfterNext);
  });
});
