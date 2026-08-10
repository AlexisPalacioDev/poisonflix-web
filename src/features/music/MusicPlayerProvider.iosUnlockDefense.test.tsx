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

describe('MusicPlayerProvider — PREVENTION: only the active element is ever probed', () => {
  // This block used to assert the opposite: that the first-gesture probe called
  // play() on BOTH elements, to unlock the preload element too in case iOS
  // scopes autoplay unlocking per-element. That probe was removed, because it
  // caused a real bug on the owner's iPhone — "it is playing but no sound comes
  // out", with currentTime advancing and paused:false.
  //
  // WebKit hands the tab's single audio focus to whichever element called
  // play() MOST RECENTLY. The probe called it on the active element first and
  // on the muted preload element second, so the last element to ask for the
  // route was the silent one. An audit confirmed this was the ONLY place in the
  // provider where two elements could be playing at once: ordinary preloading
  // only sets `src` + load(), and promoteFromPreload never calls play().
  //
  // What still covers the risk the probe was meant to address is the MITIGATION
  // block below: if a promoted element's play() is rejected, playback falls back
  // to the gesture-backed element and reports it.
  it('the first-gesture probe plays the ACTIVE element', () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle()); // pause; the active element stays loaded
    expect(api.isPlaying).toBe(false);

    const [active] = audios();
    playSpy.mockClear();

    act(() => fireEvent.pointerDown(document));

    expect(playSpy.mock.contexts).toContain(active);
  });

  it('NEVER calls play() on the preload element — it would steal the audio route', () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle());

    const [, preload] = audios();
    playSpy.mockClear();

    act(() => fireEvent.pointerDown(document));

    expect(playSpy.mock.contexts).not.toContain(preload);
  });

  it('leaves the preload element untouched: not muted, not played, not paused', () => {
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle());

    const [, preload] = audios();
    const mutedBefore = preload.muted;
    playSpy.mockClear();
    pauseSpy.mockClear();

    act(() => fireEvent.pointerDown(document));

    expect(preload.muted).toBe(mutedBefore);
    expect(playSpy.mock.contexts).not.toContain(preload);
    expect(pauseSpy.mock.contexts).not.toContain(preload);
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
