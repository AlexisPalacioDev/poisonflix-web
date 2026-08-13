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
// The tone element (`audio[loop]`) is deliberately excluded: it is the
// placeholder that covers the gap before a track sounds, it carries no
// handlers, and it never takes part in the queue. Counting it here would make
// every positional assertion in this file off by one.
  return Array.from(document.querySelectorAll<HTMLAudioElement>('audio:not([loop])'));
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
  it('renders four <audio> elements: three mixer slots, one held in reserve', () => {
    renderProvider();
    // The first three are the mixer's peer slots — they take turns as
    // current/next/prev as the engine rotates roles, and all three are routed
    // into the one AudioContext. The FOURTH is the escape element, never
    // routed, so it stays audible if that graph dies (see
    // `escapeFromAudioGraph`). Other assertions in this file destructure the
    // first two positionally, so order matters as much as the count.
    expect(audios()).toHaveLength(4);
    const [, , , escape] = audios();
    expect(escape.hasAttribute('src')).toBe(false);
    // The escape is identifiable without counting: it is the only one that is
    // not allowed to spend any network before it is needed.
    expect(escape.preload).toBe('none');
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

  it('keeps preloading working across MULTIPLE rotations — every slot can always fetch', async () => {
    // This started as a regression test for a bug adversarial review caught:
    // `preload` is a property of the physical node, not of "whichever one is
    // currently the preloader", so the old two-element design had to flip the
    // attribute on every promotion or the node that started life as the
    // `preload="none"` main element would silently stop fetching once it
    // became the preloader.
    //
    // The mixer removes the failure mode rather than managing it: three peer
    // slots that all keep `preload="auto"` for the whole session, because any
    // of them may be asked to buffer at any time. The property being asserted
    // is the same one the original test cared about — a slot about to preload
    // is always actually allowed to fetch — but it now has to hold across
    // rotations WITHOUT anything maintaining it, which is the stronger claim.
    // Three tracks and two `ended` events still reach a second rotation.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    const slots = audios().slice(0, 3);
    // `preload="auto"` on all three is a precondition, not the claim: it is
    // hardcoded in the JSX and no code path touches it, so asserting it alone
    // would be a tautology (adversarial review caught an earlier version of
    // this test doing exactly that). What has to hold is the BEHAVIOUR that
    // attribute existed to protect — that after every rotation, some slot has
    // actually buffered the track that comes next.
    expect(slots.map((el) => el.preload)).toEqual(['auto', 'auto', 'auto']);

    const holderOf = (fragment: string) =>
      slots.find((el) => el.getAttribute('src')?.includes(fragment));

    // Before any rotation: A sounding, B buffered on another slot.
    expect(holderOf('videoId=vid-a')).toBeDefined();
    expect(holderOf('videoId=vid-b')).toBeDefined();

    const holdingA = holderOf('videoId=vid-a');
    endedRaw(holdingA!); // A -> B
    await act(async () => {});
    expect(api.currentIndex).toBe(1);
    // The slot freed by the rotation picked up C — the real claim.
    expect(holderOf('videoId=vid-c')).toBeDefined();
    // …and A is still held, ready for an instant step back.
    expect(holderOf('videoId=vid-a')).toBeDefined();

    const holdingB = holderOf('videoId=vid-b');
    endedRaw(holdingB!); // B -> C
    await act(async () => {});
    expect(api.currentIndex).toBe(2);
    // C is sounding and B stayed buffered behind it. Nothing was reloaded to
    // get here: three tracks, three slots, one fetch each.
    expect(holderOf('videoId=vid-c')).toBeDefined();
    expect(holderOf('videoId=vid-b')).toBeDefined();
    expect(slots.map((el) => el.preload)).toEqual(['auto', 'auto', 'auto']);
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

describe('MusicPlayerProvider — a preload that keeps failing is left alone', () => {
  it('stops retrying one URL after a couple of failures', async () => {
    // MEASURED, not hypothetical. The owner's phone logged 94 consecutive
    // `preloadError`s for ONE videoId, 1.2 seconds apart, for as long as the
    // track kept playing: the failure cleared the slot, the retry tick bumped,
    // the effect re-ran, the load failed again, round and round. That loop
    // hammered the worker and ate the phone's connection — the single resource
    // the actual playback depends on — and is very likely why the music went
    // silent.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });

    const preload = audios().find((el) => el.getAttribute('src')?.includes('vid-b'));
    expect(preload).toBeDefined();

    // Fail it repeatedly, the way the device did.
    for (let i = 0; i < 6; i += 1) {
      const holder = audios().find((el) => el.getAttribute('src')?.includes('vid-b'));
      if (!holder) break;
      await act(async () => {
        holder.dispatchEvent(new Event('error'));
      });
    }

    // The loop is over: nothing is still holding that URL, so nothing is still
    // fetching it. Playback is untouched — the current track keeps its source.
    expect(audios().some((el) => el.getAttribute('src')?.includes('vid-b'))).toBe(false);
    expect(audios().some((el) => el.getAttribute('src')?.includes('vid-a'))).toBe(true);
    expect(api.isPlaying).toBe(true);
  });
});
