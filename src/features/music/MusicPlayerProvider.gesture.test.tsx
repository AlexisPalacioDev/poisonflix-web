import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type PlayMock = MockInstance<(...args: never[]) => Promise<void>>;
type VoidMock = MockInstance<(...args: never[]) => void>;
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';

// iOS Safari playback regression guard. The real bug: `audio.play()` used to run
// only inside a React effect (AFTER the click returned), so iOS — which requires
// play() to be called synchronously inside the user gesture — rejected it with
// NotAllowedError and the track never advanced. These tests assert the fix:
// the context methods invoked from onClick/onTouch (playNow / toggle / next /
// prev / jumpTo) drive `audio.play()` SYNCHRONOUSLY, within the same call stack
// as the gesture, before React flushes any effect.
//
// jsdom can't emulate iOS's autoplay policy, so we can't prove the OS accepts
// the call — but we CAN prove play() now runs in the gesture call stack (the
// actual iOS requirement) by capturing the spy count inside the synchronous act
// callback, before effects flush.

const tracks: MusicTrack[] = [
  { itemId: 'a', title: 'Track A', artist: 'Artist A', coverUrl: null },
  { itemId: 'b', title: 'Track B', artist: 'Artist B', coverUrl: null },
  { itemId: 'c', title: 'Track C', artist: 'Artist C', coverUrl: null },
];

let playSpy: PlayMock;
let loadSpy: VoidMock;

// Captures the live context value so the test can invoke the gesture methods
// directly (a click handler calls exactly these).
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

/** The `<audio>` element currently carrying `urlFragment`. With three rotating
 *  mixer slots, the element playing a given track is not a fixed DOM node. */
function activeElementFor(urlFragment: string): HTMLAudioElement | undefined {
  return Array.from(document.querySelectorAll('audio')).find((el) =>
    el.getAttribute('src')?.includes(urlFragment),
  );
}

function audioEl(): HTMLAudioElement {
  return document.querySelector('audio') as HTMLAudioElement;
}

/** Instruments the element's `src` setter so we can count (re)assignments. */
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
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}) as VoidMock;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
});

describe('MusicPlayerProvider — gesture-synchronous playback (iOS regression)', () => {
  it('playNow calls audio.play() synchronously inside the gesture, before effects flush', () => {
    renderProvider();

    let syncPlayCount = -1;
    act(() => {
      api.playNow(tracks, 0);
      // Captured while still inside the synchronous act callback: effects have
      // NOT run yet, so any play() here came from the gesture call stack.
      syncPlayCount = playSpy.mock.calls.length;
    });

    expect(syncPlayCount).toBeGreaterThanOrEqual(1);
    // And the element points at the track chosen by the gesture.
    expect(audioEl().getAttribute('src')).toContain('Audio/a/stream.m4a');
  });

  it('toggle (resume) calls audio.play() synchronously inside the gesture', () => {
    renderProvider();
    act(() => api.playNow(tracks, 0));
    // Pause first (so toggle resumes).
    act(() => api.toggle());
    expect(api.isPlaying).toBe(false);

    playSpy.mockClear();
    let syncPlayCount = -1;
    act(() => {
      api.toggle();
      syncPlayCount = playSpy.mock.calls.length;
    });

    expect(syncPlayCount).toBe(1);
    expect(api.isPlaying).toBe(true);
  });

  it('next advances src and plays synchronously within the gesture', () => {
    renderProvider();
    act(() => api.playNow(tracks, 0));

    playSpy.mockClear();
    let syncPlayCount = -1;
    act(() => {
      api.next();
      syncPlayCount = playSpy.mock.calls.length;
    });

    expect(syncPlayCount).toBeGreaterThanOrEqual(1);
    // The track no longer lands on a fixed DOM node: the mixer rotates roles
    // between three peer slots, so "the active element" is whichever one holds
    // the new track — deliberately NOT `audioEl()` (the first node), which is
    // now the OUTGOING element still holding track A as `prev`. Finding the
    // element by the track it carries asserts the same thing the src check
    // always did (the gesture reached the right track, synchronously) without
    // assuming which physical node it landed on.
    const active = activeElementFor('Audio/b/stream.m4a');
    expect(active).toBeDefined();
    expect(playSpy.mock.contexts).toContain(active);
    expect(api.currentIndex).toBe(1);
  });

  it('jumpTo plays the targeted track synchronously within the gesture', () => {
    renderProvider();
    act(() => api.playNow(tracks, 0));

    playSpy.mockClear();
    let syncPlayCount = -1;
    act(() => {
      api.jumpTo(2);
      syncPlayCount = playSpy.mock.calls.length;
    });

    expect(syncPlayCount).toBeGreaterThanOrEqual(1);
    // Same as above — and a jump is the case worth stating explicitly: it is
    // the one transition no neighbour had buffered, so the mixer loads it onto
    // a NEIGHBOUR slot and rotates into that, rather than reassigning the src
    // of the element that is sounding.
    const active = activeElementFor('Audio/c/stream.m4a');
    expect(active).toBeDefined();
    expect(playSpy.mock.contexts).toContain(active);
  });

  it('re-playNow of the SAME track does not reassign src (no needless reload)', () => {
    renderProvider();
    act(() => api.playNow(tracks, 0));

    const audio = audioEl();
    const { srcSets } = trackSrcAssignments(audio);
    loadSpy.mockClear();
    playSpy.mockClear();

    act(() => api.playNow(tracks, 0)); // same tracks, same index

    // The guard means src is NOT reassigned and the element is NOT reloaded…
    expect(srcSets).toHaveLength(0);
    expect(loadSpy).not.toHaveBeenCalled();
    // …but playback is still (re)driven.
    expect(playSpy).toHaveBeenCalled();
  });

  it('a rejected play() after the element is unlocked does NOT flip isPlaying to paused', async () => {
    renderProvider();
    // First play succeeds → element becomes "unlocked".
    await act(async () => {
      api.playNow(tracks, 0);
    });
    expect(api.isPlaying).toBe(true);

    // A later transient rejection (e.g. brief interruption) must not lie about
    // state now that the element is unlocked.
    playSpy.mockRejectedValueOnce(new DOMException('interrupted', 'AbortError'));
    await act(async () => {
      api.next();
    });

    expect(api.isPlaying).toBe(true);
    expect(api.currentIndex).toBe(1);
  });
});
