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
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
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

  it('NEVER calls play() on another element while audio is actually sounding', () => {
    // THE INVARIANT THAT MATTERS, and it is not quite the one this test used
    // to assert. The original rule was absolute — never play the preload
    // element, full stop — and it came from a real incident (92b215f): a probe
    // played a second element AFTER the real one, WebKit handed the single
    // audio route to whoever asked most recently, and the owner's iPhone
    // reported "it says it is playing but there is no sound".
    //
    // The mechanism there is the ROUTE being taken from a sounding element. If
    // nothing is sounding, there is no route to take, which is why the mixer's
    // slots are now unlocked in that case (see the unlock effect, and the
    // device evidence quoted there: iOS refuses a rotated slot that never got
    // a gesture, and the track sits fully buffered at t=0, never started).
    //
    // So the guarantee is stated as what actually prevents the incident: while
    // audio is playing, nothing else is ever asked to play.
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    expect(api.isPlaying).toBe(true);

    const [active, ...others] = audios();
    Object.defineProperty(active, 'paused', { value: false, configurable: true });
    playSpy.mockClear();

    act(() => fireEvent.pointerDown(document));

    // The escape element is the one deliberate exception, unchanged from
    // before the mixer: it plays 50ms of EMBEDDED silence that ends on its
    // own, and it runs on `pointerdown` — ahead of the `click` that starts any
    // song — so it can never be the most recent caller when a track begins.
    // That behaviour has been in production without regressing 92b215f.
    const mixerSlots = others.filter((el) => el.preload !== 'none');
    expect(mixerSlots.length).toBeGreaterThan(0);
    for (const el of mixerSlots) {
      expect(playSpy.mock.contexts).not.toContain(el);
    }
  });

  it('unlocks the mixer slots when nothing is sounding, so a rotation is not refused', () => {
    // The other half. Measured on the owner's device on the previous build:
    // `music.player.rotationPlayRejected` fired, and the traces show the
    // rotated slot fully buffered (`ready: 4`) and paused at `t: 0` — audio
    // that was never allowed to begin, not audio that stopped. Leaving two of
    // three rotating slots without a gesture of their own is what produces
    // that, so with the player quiet they each get 50ms of embedded silence.
    renderProvider();
    act(() => api.playNow([LIBRARY_A, LIBRARY_B], 0));
    act(() => api.toggle()); // pause; nothing is sounding now
    expect(api.isPlaying).toBe(false);

    const all = audios();
    playSpy.mockClear();

    act(() => fireEvent.pointerDown(document));

    // Every element got its gesture-backed play, so no slot is left refusable.
    for (const el of all) {
      expect(playSpy.mock.contexts).toContain(el);
    }
  });
});

describe('MusicPlayerProvider — MITIGATION: when a rotated slot refuses to play', () => {
  // THE MECHANISM CHANGED, the risk did not. The old design had one
  // gesture-backed element that played everything, so a promoted element whose
  // play() was refused could be swapped back to it. The mixer has no such
  // element: all three slots are peers and each becomes the playing element in
  // turn, so there is nowhere to fall back TO — rotating again would just hand
  // the track to another slot with the same problem.
  //
  // What replaces it: report the refusal (whether it ever fires on a real
  // device is the one piece of evidence that would tell us iOS's autoplay
  // unlock is per-element at all), disarm the stall watchdog so it cannot walk
  // the queue skipping tracks that were never stalled, and replay on the next
  // real user interaction. Deliberately NO reload: the slot is holding a fully
  // buffered track, and reloading would throw that away to fix something that
  // is not about buffering.
  it('does not reload the refused slot, and plays again on the next interaction', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const [first, second] = audios();
    expect(second.getAttribute('src')).toContain('videoId=vid-b'); // B buffered on the next slot

    const { srcSets: secondSrcSets } = trackSrcAssignments(second);
    // Spied locally: this file mocks play/pause globally but not load, and
    // "the buffered slot was not reloaded" is half of what this test asserts.
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    playSpy.mockImplementationOnce(() =>
      Promise.reject(new DOMException('not allowed', 'NotAllowedError')),
    );

    await act(async () => {
      endedRaw(first);
    });

    // The queue still advanced (the reducer dispatch does not depend on
    // whether play() succeeds).
    expect(api.currentIndex).toBe(1);
    expect(api.isPlaying).toBe(true);
    // The buffered slot was NOT reassigned or reloaded — the whole point of
    // having preloaded it survives the refusal.
    expect(secondSrcSets).toHaveLength(0);
    expect(loadSpy.mock.instances).not.toContain(second);

    // And a real interaction gets the sound back.
    playSpy.mockClear();
    await act(async () => {
      fireEvent.pointerDown(document);
    });
    expect(playSpy.mock.instances).toContain(second);
  });

  it('reports the refused rotation via reportFailure with its own scope', async () => {
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

    const report = recordedFailures().find((f) => f.scope === 'music.player.rotationPlayRejected');
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

describe('MusicPlayerProvider — the unlock must not get in the way of the music', () => {
  it('still plays the track when the unlock ran first, in the same gesture', async () => {
    // THE REAL SEQUENCE, which no other test covered: the user's finger fires
    // `pointerdown` (which unlocks the slots) and then the `click` that starts
    // the song. Every other test in this file calls the API directly, so the
    // unlock had never run BEFORE playback in a test — and a regression that
    // left the silent clip sitting on the slots, with the track never loading
    // at all, reached production because of that gap.
    renderProvider();

    act(() => fireEvent.pointerDown(document));
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });

    // Some element is actually holding the requested track.
    const holder = audios().find((el) => el.getAttribute('src')?.includes('vid-a'));
    expect(holder).toBeDefined();
    expect(playSpy.mock.contexts).toContain(holder);
    // And no mixer slot is left with the unlock clip standing in for a track.
    const stuck = audios()
      .filter((el) => el.preload !== 'none')
      .filter((el) => el.getAttribute('src')?.startsWith('data:'));
    expect(stuck).toHaveLength(0);
  });
});
