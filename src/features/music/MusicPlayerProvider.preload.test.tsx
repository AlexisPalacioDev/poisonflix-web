import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';

type PlayMock = MockInstance<(...args: never[]) => Promise<void>>;
type PauseMock = MockInstance<(...args: never[]) => void>;
type LoadMock = MockInstance<(...args: never[]) => void>;

// Double buffering (see MusicPlayerProvider.tsx's preload effect docstring
// for the measurement this is built on): while the CURRENT track plays, the
// NEXT queue track is preloaded onto a SEPARATE, hidden <audio> element, and
// that element is PROMOTED (not re-`src`'d) when the track actually
// advances — the only way "already preloaded" can mean anything, since
// buffered bytes live on the specific element that fetched them.
//
// jsdom cannot reproduce iOS's background network suspension, so none of this
// proves a hang recovers on a real device. What IS assertable here: the
// preload element's `src`/`load()` calls, that it never calls `play()`, and
// that a promotion reuses the already-loaded element instead of issuing a
// fresh load.

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
// A downloaded library track: no `streamUrl`, plays straight off Jellyfin.
// Deliberately excluded from preloading (see the provider's docstring) —
// used here to assert that exclusion holds.
const LIBRARY_TRACK: MusicTrack = {
  itemId: 'aud-1',
  title: 'Library Track',
  artist: 'Artist L',
  coverUrl: null,
};

let playSpy: PlayMock;
let pauseSpy: PauseMock;
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

/** Both physical <audio> elements, in DOM (JSX) order — this order never
 *  changes even after a promotion swaps which one is logically "active". */
function audios(): HTMLAudioElement[] {
  return Array.from(document.querySelectorAll('audio'));
}

function endedRaw(el: HTMLAudioElement) {
  el.dispatchEvent(new Event('ended'));
}

/** Instruments an element's `src` setter so tests can count (re)assignments
 *  without relying on `getAttribute` (jsdom doesn't fully resolve `.src`). */
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
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}) as LoadMock;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
});

describe('MusicPlayerProvider — double buffering: preloading the next track', () => {
  it('renders three <audio> elements: two for double buffering, one held in reserve', () => {
    renderProvider();
    // The third is the escape element (slot C) — never routed into the
    // keepalive's AudioContext, so it stays audible if that graph dies. See
    // `escapeFromAudioGraph`. The first two are still the double-buffer pair,
    // and every other assertion in this file destructures them positionally,
    // so their order matters as much as the count.
    expect(audios()).toHaveLength(3);
    const [, , escape] = audios();
    expect(escape.hasAttribute('src')).toBe(false);
  });

  it('preloads the next track onto the SECOND element while the current one plays', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });

    const [active, preload] = audios();
    expect(active.getAttribute('src')).toContain('videoId=vid-a');
    // Only ONE track ahead: the preload element holds B, never C.
    expect(preload.getAttribute('src')).toContain('videoId=vid-b');
    expect(preload.getAttribute('src')).not.toContain('videoId=vid-c');
  });

  it('does not preload a track that is already in the library (no streamUrl)', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, LIBRARY_TRACK], 0);
    });

    const [, preload] = audios();
    expect(preload.hasAttribute('src')).toBe(false);
  });

  it('does not preload while paused', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    await act(async () => {
      api.toggle(); // pause
    });

    const [, preload] = audios();
    expect(preload.hasAttribute('src')).toBe(false);
  });

  it('follows the queue forward: advancing preloads the new next track, one ahead at a time', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    expect(audios()[1].getAttribute('src')).toContain('videoId=vid-b');

    endedRaw(audios()[0]);
    await act(async () => {});

    // After advancing to B, the two elements must be "B playing, C
    // preloading" — never both B and C preloaded (which would be two ahead)
    // and never C preloaded before B is even current.
    expect(api.currentIndex).toBe(1);
    const srcs = audios().map((el) => el.getAttribute('src') ?? '');
    expect(srcs.some((s) => s.includes('videoId=vid-b'))).toBe(true);
    expect(srcs.some((s) => s.includes('videoId=vid-c'))).toBe(true);
  });

  it('the preload element does not call play() from the ordinary preload cycle itself', async () => {
    // NOTE: this is no longer an absolute "never" — the belt-and-suspenders
    // first-user-gesture unlock effect now ALSO probes the preload element
    // once per session (see MusicPlayerProvider.tsx and
    // MusicPlayerProvider.iosUnlockDefense.test.tsx). That is a deliberate,
    // separate, muted play()->pause() unrelated to preloading; this test
    // never fires a `pointerdown`, so it still correctly asserts that
    // merely loading a track onto the preload element — the preload EFFECT's
    // own job — never itself calls play().
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    const [, preload] = audios(); // holds B, still just preloading — A hasn't ended
    expect(preload.getAttribute('src')).toContain('videoId=vid-b');

    expect(playSpy.mock.instances).not.toContain(preload);
  });

  it('advancing to a preloaded track promotes it: play() runs on the ALREADY-loaded element, no new src assignment', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const [first, second] = audios();
    expect(second.getAttribute('src')).toContain('videoId=vid-b');

    const { srcSets } = trackSrcAssignments(second);
    loadSpy.mockClear();
    playSpy.mockClear();

    endedRaw(first);
    await act(async () => {});

    // The promoted element (`second`) already had the URL — no re-assignment,
    // no fresh load() on it; the whole point of preloading is that these are
    // zero. `load()` may still legitimately fire elsewhere (e.g. the demoted
    // element being repurposed to preload C), so the assertion is scoped to
    // `second` specifically via `mock.instances`, not to the spy globally.
    expect(srcSets).toHaveLength(0);
    expect(loadSpy.mock.instances).not.toContain(second);
    expect(playSpy.mock.instances).toContain(second);
    expect(api.currentIndex).toBe(1);
  });

  it('keeps preloading working across MULTIPLE promotions — the `preload` attribute follows the role, not the DOM node', async () => {
    // Regression test for a bug adversarial review caught: `preload` is a
    // property of the physical node, not of "whichever one is currently the
    // preloader". The first promotion alone couldn't expose it (the node
    // that starts as JSX's preload element already has `preload="auto"`);
    // only a SECOND promotion — where the roles invert back — could, because
    // by then the preloading node is the one that started life as the main,
    // `preload="none"` element, and that value doesn't automatically follow
    // the role swap. Three tracks and two `ended` events are the minimum
    // that reaches a second promotion.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    const [elA, elB] = audios();
    expect(elA.preload).toBe('none'); // active (holds A)
    expect(elB.preload).toBe('auto'); // preloading (holds B)

    endedRaw(elA); // A -> B: elB promoted (active), elA repurposed to preload C
    await act(async () => {});
    expect(api.currentIndex).toBe(1);
    expect(elB.preload).toBe('none'); // now active
    expect(elA.preload).toBe('auto'); // now preloading — MUST be 'auto' to actually fetch

    endedRaw(elB); // B -> C: elA promoted back to active
    await act(async () => {});
    expect(api.currentIndex).toBe(2);
    expect(elA.preload).toBe('none'); // active again
    expect(elB.preload).toBe('auto'); // preloading again
  });

  it('a manual skip while the current track is still playing pauses the demoted element (no overlapping audio)', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const [first] = audios();
    // jsdom's mocked play()/pause() (see beforeEach) never flip the real
    // `paused` getter the way a real browser would — force it to reflect
    // "actively playing" so the demote-time guard has something real to act
    // on, the same way other tests in this suite force `duration`/`ended`.
    Object.defineProperty(first, 'paused', { configurable: true, value: false });
    pauseSpy.mockClear();

    // Manual "next" — the current track has NOT ended, so without an
    // explicit pause on the demoted element both would play at once.
    await act(async () => {
      api.next();
    });

    expect(pauseSpy.mock.instances).toContain(first);
  });
});
