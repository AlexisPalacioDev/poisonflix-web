import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { clearRecordedFailures, recordedFailures } from '../../lib/obs/report';

// The silent Web Audio keepalive (silentKeepalive.ts): while real playback is
// active, a silent AudioContext graph stays alive alongside the <audio>
// elements, on the owner's reasoned (unverified on-device) hypothesis that
// keeping the tab's audio pipeline "busy" through the gap between tracks
// helps iOS avoid the 60-110s silent hangs traced on his phone (see
// MusicPlayerProvider's own STALL_WATCHDOG_MS docstring for the measurement).
//
// jsdom has no Web Audio implementation, so every test here installs a
// minimal fake `AudioContext` on `window` and asserts against ITS behaviour —
// exactly the same trade this codebase already makes for MediaSession
// (see MusicPlayerProvider.mediasession.test.tsx).
//
// The fake settles `state` on a microtask AFTER `resume()`/`suspend()`/
// `close()` is called — matching the real, asynchronous `AudioContext` state
// machine (a synchronous stand-in would hide the exact race adversarial
// review found in `suspend()`'s docstring in silentKeepalive.ts).

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeGainNode {
  gain = { value: 1 };
  connect = vi.fn();
}

class FakeBufferSourceNode {
  buffer: unknown = null;
  loop = false;
  startCalls = 0;
  connect = vi.fn();
  start() {
    this.startCalls += 1;
    if (this.startCalls > 1) {
      throw new DOMException('cannot start more than once', 'InvalidStateError');
    }
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  sampleRate = 44100;
  destination = {};
  resumeMock = vi.fn(() => Promise.resolve().then(() => void (this.state = 'running')));
  suspendMock = vi.fn(() => Promise.resolve().then(() => void (this.state = 'suspended')));
  closeMock = vi.fn(() => Promise.resolve().then(() => void (this.state = 'closed')));
  lastGain: FakeGainNode | null = null;
  lastSource: FakeBufferSourceNode | null = null;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    this.lastGain = new FakeGainNode();
    return this.lastGain;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate };
  }
  createBufferSource() {
    this.lastSource = new FakeBufferSourceNode();
    return this.lastSource;
  }
  resume() {
    return this.resumeMock();
  }
  suspend() {
    return this.suspendMock();
  }
  close() {
    return this.closeMock();
  }
}

// Records the interleaving of the REAL element's play() against the
// keepalive's AudioContext construction — the one thing REQUIREMENT 4 ("the
// real track commands") depends on and which no assertion previously checked
// directly.
let callOrder: string[];

const track: MusicTrack = { itemId: 'a', title: 'A', artist: null, coverUrl: null, videoId: 'v-a' };
const trackB: MusicTrack = { itemId: 'b', title: 'B', artist: null, coverUrl: null, videoId: 'v-b' };

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
  callOrder = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    callOrder.push('audio.play');
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  FakeAudioContext.instances = [];
  clearRecordedFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSession();
});

describe('MusicPlayerProvider — silent keepalive lifecycle', () => {
  it('starts the keepalive when real playback begins, tied to the same gesture', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
    });

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.lastSource?.startCalls).toBe(1);
    expect(ctx.resumeMock).toHaveBeenCalled();
  });

  it('builds and resumes the keepalive BEFORE the real <audio> element play()', async () => {
    class OrderTrackingAudioContext extends FakeAudioContext {
      constructor() {
        super();
        callOrder.push('AudioContext.constructor');
      }
      resume() {
        callOrder.push('ctx.resume');
        return super.resume();
      }
    }
    vi.stubGlobal('AudioContext', OrderTrackingAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
    });

    // Order is the feature, not an implementation detail. The tone has to be
    // sounding while the real track is still loading, because that load is the
    // stretch with no audio at all — the stretch iOS freezes the tab in. And
    // WebKit gives the audio route to whoever asked LAST, so the song must ask
    // after the silence, never before, or the silence holds the route.
    //
    // The declarative play/pause effect (unrelated to this feature) may call
    // `audio.play()` again once React flushes, so this asserts RELATIVE order
    // against the element's FIRST play() rather than an exact call sequence.
    const firstPlay = callOrder.indexOf('audio.play');
    const ctorIndex = callOrder.indexOf('AudioContext.constructor');
    const resumeIndex = callOrder.indexOf('ctx.resume');
    expect(ctorIndex).toBe(0);
    expect(resumeIndex).toBeGreaterThan(ctorIndex);
    expect(firstPlay).toBeGreaterThan(resumeIndex);
  });

  it('the keepalive gain is exactly 0 — silent, not just quiet', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
    });

    expect(FakeAudioContext.instances[0].lastGain?.gain.value).toBe(0);
  });

  it('does NOT suspend the tone when the user pauses — that is what holds the session', async () => {
    // This test asserted the OPPOSITE until the mixer landed, and the reversal
    // is deliberate. Suspending on every pause hands the audio session back to
    // the OS, and then pressing play on a locked phone is asking for it back
    // with no user gesture to justify it — the same hole the mixer closed for
    // track changes, just moved onto the pause button. The current track
    // pauses, the neighbours were already paused, and the tone keeps running
    // underneath all of it.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
      await flushMicrotasks();
    });
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('running');

    await act(async () => {
      api.toggle(); // pause
      await flushMicrotasks();
    });

    expect(ctx.suspendMock).not.toHaveBeenCalled();
    expect(ctx.state).toBe('running');
  });

  it('keeps the keepalive alive across an auto-advance — the exact gap the feature targets — instead of suspending between tracks', async () => {
    // The traced hang happens in the gap between one track ending and the
    // next one's audio actually starting. If the keepalive suspended during
    // that gap (even briefly, because `isPlaying` never actually went false —
    // the reducer's NEXT branch keeps it true when another track remains),
    // it would be silent for exactly the window it exists to cover.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track, trackB], 0);
      await flushMicrotasks();
    });
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('running');

    await act(async () => {
      audioEl().dispatchEvent(new Event('ended')); // auto-advance to trackB
      await flushMicrotasks();
    });

    expect(api.currentIndex).toBe(1);
    expect(api.isPlaying).toBe(true);
    expect(ctx.suspendMock).not.toHaveBeenCalled();
    expect(ctx.state).toBe('running');
    // Still the SAME context/source — no rebuild across the track boundary.
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('stops the keepalive when the queue runs out, not just on an explicit pause', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0); // a single-track queue, no repeat
      await flushMicrotasks();
    });
    const ctx = FakeAudioContext.instances[0];

    // The element itself reports the end of the track — the queue has
    // nothing left, so the reducer's NEXT branch flips isPlaying false.
    await act(async () => {
      audioEl().dispatchEvent(new Event('ended'));
      await flushMicrotasks();
    });

    expect(api.isPlaying).toBe(false);
    // Same reversal as the pause case above, for the same reason: a queue that
    // ran out is still a music session the listener may resume, and giving the
    // audio session back is a one-way move on a locked phone. What the queue
    // running out DOES change is intent — see the keepalive's own
    // `setPlaybackIntent` tests for why that distinction has to exist.
    expect(ctx.suspendMock).not.toHaveBeenCalled();
    expect(ctx.state).toBe('running');
  });

  it('does not create a second AudioContext across repeated pause/resume cycles', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
      await flushMicrotasks();
    });
    await act(async () => {
      api.toggle(); // pause
      await flushMicrotasks();
    });
    await act(async () => {
      api.toggle(); // resume
      await flushMicrotasks();
    });
    await act(async () => {
      api.toggle(); // pause
      await flushMicrotasks();
    });
    await act(async () => {
      api.toggle(); // resume
      await flushMicrotasks();
    });

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].lastSource?.startCalls).toBe(1);
  });

  it('closes the keepalive context on unmount', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { unmount } = renderProvider();

    await act(async () => {
      api.playNow([track], 0);
      await flushMicrotasks();
    });
    const ctx = FakeAudioContext.instances[0];

    unmount();

    expect(ctx.closeMock).toHaveBeenCalled();
  });

  it('playback works exactly as before when Web Audio is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
    });

    expect(api.isPlaying).toBe(true);
    expect(audioEl().play).toHaveBeenCalled();
  });

  it('playback works exactly as before when the keepalive resume() rejects', async () => {
    class RejectingAudioContext extends FakeAudioContext {
      resumeMock = vi.fn(() => Promise.reject(new Error('blocked')));
    }
    vi.stubGlobal('AudioContext', RejectingAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
    });

    expect(api.isPlaying).toBe(true);
    expect(audioEl().play).toHaveBeenCalled();

    // Advancing to the next track exercises the keepalive again — still must
    // not disturb playback.
    await act(async () => {
      api.toggle();
    });
    await act(async () => {
      api.toggle();
    });
    expect(api.isPlaying).toBe(true);
  });

  it('playback works exactly as before when the keepalive resume() THROWS SYNCHRONOUSLY', async () => {
    // Regression test for the real bug adversarial review found: an
    // unguarded synchronous throw inside `start()` (called mid-`playImperative`,
    // right after the real `audio.play()`) would have propagated out of
    // `playImperative` itself — before the real element's own play() promise
    // handlers were ever registered, silently breaking the unlock/fallback
    // bookkeeping this whole file depends on.
    class ThrowingAudioContext extends FakeAudioContext {
      resume(): Promise<void> {
        throw new DOMException('blocked', 'InvalidStateError');
      }
    }
    vi.stubGlobal('AudioContext', ThrowingAudioContext);
    renderProvider();

    expect(() => {
      act(() => {
        api.playNow([track], 0);
      });
    }).not.toThrow();

    expect(api.isPlaying).toBe(true);
    expect(audioEl().play).toHaveBeenCalled();
  });

  it('the lock diagnostics trace includes the keepalive AudioContext state', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
      await flushMicrotasks();
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    act(() => fireEvent.pause(audioEl()));

    const shipped = recordedFailures().find((f) => f.scope === 'music.lock.trace');
    expect(shipped).toBeDefined();
    const trace = shipped?.detail as Array<Record<string, unknown>>;
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.some((s) => s.keepaliveState === 'running')).toBe(true);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('reports keepaliveState null in the trace when Web Audio is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    renderProvider();

    await act(async () => {
      api.playNow([track], 0);
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    act(() => fireEvent.pause(audioEl()));

    const shipped = recordedFailures().find((f) => f.scope === 'music.lock.trace');
    const trace = shipped?.detail as Array<Record<string, unknown>>;
    expect(trace.some((s) => s.keepaliveState === null)).toBe(true);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
});
