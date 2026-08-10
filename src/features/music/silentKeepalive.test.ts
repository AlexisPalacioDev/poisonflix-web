import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSilentKeepalive } from './silentKeepalive';

// jsdom has no Web Audio implementation at all, so every test here drives a
// minimal fake `AudioContext` that mirrors the handful of methods
// `silentKeepalive.ts` actually calls. This suite is deliberately about the
// CONTRACT (gain is exactly 0, one context per session, every failure is
// swallowed) rather than proving anything about real iOS behaviour — that is
// unverifiable from here, same as the rest of MusicPlayerProvider's iOS-only
// assumptions.
//
// The fakes below settle `state` asynchronously, on a microtask, the same way
// a real `AudioContext` only flips `state` once `resume()`/`suspend()`/
// `close()`'s own promise actually settles — NOT synchronously when the call
// is made. An earlier version of this suite flipped `state` synchronously
// inside the mock, which made every test pass regardless of whether
// `silentKeepalive.ts` read `.state` correctly, and hid a real race
// (documented on `suspend()`'s own docstring) that only exists because the
// real API is asynchronous. See "resolves without a hard-coded flip" below.

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
  start(_when?: number) {
    this.startCalls += 1;
    // Mirrors the real spec: a buffer source can only ever be started once.
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
  // Each resolves on a microtask AFTER being called — matching the real,
  // asynchronous `AudioContext` state machine, not a synchronous stand-in.
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

beforeEach(() => {
  FakeAudioContext.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSilentKeepalive', () => {
  it('starts with gain exactly 0 — silence, not just "quiet"', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    keepalive.start();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.lastGain?.gain.value).toBe(0);
  });

  it('loops a never-ending source so the graph never falls silent on its own', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    keepalive.start();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.lastSource?.loop).toBe(true);
    expect(ctx.lastSource?.startCalls).toBe(1);
  });

  it('reports the live AudioContext state only once the real async transition actually settles', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();
    expect(keepalive.getState()).toBeNull(); // nothing built yet

    keepalive.start();
    // `resume()` was CALLED, but its promise has not settled yet — a real
    // AudioContext reports 'suspended' at this exact point too.
    expect(keepalive.getState()).toBe('suspended');
    await flushMicrotasks();
    expect(keepalive.getState()).toBe('running');

    keepalive.suspend();
    await flushMicrotasks();
    expect(keepalive.getState()).toBe('suspended');

    keepalive.close();
    // Releasing the handle's reference is synchronous even though the
    // underlying `close()` call resolves later — see `close()`'s docstring.
    expect(keepalive.getState()).toBeNull();
  });

  it('creates exactly one AudioContext across repeated pause/resume cycles', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    keepalive.start();
    await flushMicrotasks();
    keepalive.suspend();
    await flushMicrotasks();
    keepalive.start();
    await flushMicrotasks();
    keepalive.suspend();
    await flushMicrotasks();
    keepalive.start();
    await flushMicrotasks();

    expect(FakeAudioContext.instances).toHaveLength(1);
    // The buffer source is only ever started once in its lifetime — a second
    // `.start()` call on it would throw. Every `start()` call above resumed
    // the SAME context/source instead of rebuilding.
    expect(FakeAudioContext.instances[0].lastSource?.startCalls).toBe(1);
  });

  it('a rapid pause immediately followed by resume ends up running, not stuck suspended', async () => {
    // Regression test for the race adversarial review found: `suspend()`
    // used to skip calling `ctx.suspend()` at all unless it read
    // `ctx.state === 'running'` first, and `AudioContext.state` only flips
    // once the PREVIOUS call's promise has settled — a fast pause->resume
    // could read a stale 'suspended' snapshot and no-op, leaving the real
    // suspend()/resume() calls unissued or issued out of the order the user
    // actually intended. `suspend()`/`start()` now issue their calls
    // unconditionally and let the browser's own control-message queue
    // (guaranteed ordered per the Web Audio spec) decide the outcome.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    keepalive.start(); // resume() #1 queued, not yet settled
    keepalive.suspend(); // suspend() queued right behind it, while state still reads 'suspended'
    keepalive.start(); // resume() #2 queued — the user's last word was "play"

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeMock).toHaveBeenCalledTimes(2);
    expect(ctx.suspendMock).toHaveBeenCalledTimes(1);
    // The user's last action was resume — the context must not be left
    // silently suspended while the real track keeps playing.
    expect(keepalive.getState()).toBe('running');
  });

  it('never throws when Web Audio is unavailable — playback must not depend on this', () => {
    vi.stubGlobal('AudioContext', undefined);
    const keepalive = createSilentKeepalive();

    expect(() => keepalive.start()).not.toThrow();
    expect(() => keepalive.suspend()).not.toThrow();
    expect(() => keepalive.close()).not.toThrow();
    expect(keepalive.getState()).toBeNull();
  });

  it('never throws (and stays usable) when resume() rejects', async () => {
    class RejectingAudioContext extends FakeAudioContext {
      resumeMock = vi.fn(() => Promise.reject(new Error('blocked')));
    }
    vi.stubGlobal('AudioContext', RejectingAudioContext);
    const keepalive = createSilentKeepalive();

    expect(() => keepalive.start()).not.toThrow();
    await flushMicrotasks();
    // Swallowed — no unhandled rejection propagates out of this module, and
    // a second call is still safe.
    expect(() => keepalive.start()).not.toThrow();
  });

  it('never throws when resume() THROWS SYNCHRONOUSLY instead of rejecting', () => {
    // Regression test for the real bug adversarial review found: the first
    // version only wrapped a REJECTED promise, not a call that throws
    // outright — reachable on legacy/partial `webkitAudioContext`
    // implementations. A synchronous throw here used to propagate straight
    // out of `start()`, which is called mid-`playImperative`, BEFORE the real
    // element's own play() promise handlers are registered — exactly the
    // damage REQUIREMENT 5 forbids.
    class ThrowingResumeAudioContext extends FakeAudioContext {
      resume(): Promise<void> {
        throw new DOMException('resume rejected synchronously', 'InvalidStateError');
      }
    }
    vi.stubGlobal('AudioContext', ThrowingResumeAudioContext);
    const keepalive = createSilentKeepalive();

    expect(() => keepalive.start()).not.toThrow();
  });

  it('never throws when suspend() THROWS SYNCHRONOUSLY', async () => {
    class ThrowingSuspendAudioContext extends FakeAudioContext {
      suspend(): Promise<void> {
        throw new Error('suspend blew up while running');
      }
    }
    vi.stubGlobal('AudioContext', ThrowingSuspendAudioContext);
    const keepalive = createSilentKeepalive();
    keepalive.start();
    await flushMicrotasks();

    expect(() => keepalive.suspend()).not.toThrow();
  });

  it('never throws when close() THROWS SYNCHRONOUSLY', async () => {
    class ThrowingCloseAudioContext extends FakeAudioContext {
      close(): Promise<void> {
        throw new Error('close blew up');
      }
    }
    vi.stubGlobal('AudioContext', ThrowingCloseAudioContext);
    const keepalive = createSilentKeepalive();
    keepalive.start();
    await flushMicrotasks();

    expect(() => keepalive.close()).not.toThrow();
  });

  it('never throws when the AudioContext constructor itself throws', () => {
    class ThrowingAudioContext {
      constructor() {
        throw new Error('blocked by browser policy');
      }
    }
    vi.stubGlobal('AudioContext', ThrowingAudioContext);
    const keepalive = createSilentKeepalive();

    expect(() => keepalive.start()).not.toThrow();
    expect(keepalive.getState()).toBeNull();
  });

  it('never throws on a legacy AudioContext shape missing resume/suspend/close entirely', () => {
    // Some historical `webkitAudioContext` builds never implemented these —
    // calling a method that does not exist throws a TypeError, which is a
    // SYNCHRONOUS throw, not a rejection. `safeInvoke` must catch this too.
    class IncompleteAudioContext {
      static instances: IncompleteAudioContext[] = [];
      state: AudioContextState = 'suspended';
      sampleRate = 44100;
      destination = {};
      constructor() {
        IncompleteAudioContext.instances.push(this);
      }
      createGain() {
        return new FakeGainNode();
      }
      createBuffer(_c: number, length: number, sr: number) {
        return { length, sampleRate: sr };
      }
      createBufferSource() {
        return new FakeBufferSourceNode();
      }
      // No resume/suspend/close at all.
    }
    vi.stubGlobal('AudioContext', IncompleteAudioContext);
    const keepalive = createSilentKeepalive();

    expect(() => keepalive.start()).not.toThrow();
    expect(() => keepalive.suspend()).not.toThrow();
    expect(() => keepalive.close()).not.toThrow();
  });

  it('rebuilds the graph when the browser has closed the context out from under it', async () => {
    // Safari-specific scenario this feature exists for: an 'interrupted'
    // session (phone call, route change) can degrade to 'closed'. The next
    // real play gesture must still get a working keepalive, not a
    // permanently dead handle.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    keepalive.start();
    await flushMicrotasks();
    expect(FakeAudioContext.instances).toHaveLength(1);

    // The OS/browser closed it without this module calling close() itself.
    FakeAudioContext.instances[0].state = 'closed';

    keepalive.start();
    await flushMicrotasks();

    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(keepalive.getState()).toBe('running');
  });

  it('close() is a no-op when nothing was ever built', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    expect(() => keepalive.close()).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('close() is safe to call twice', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();
    keepalive.start();
    await flushMicrotasks();

    expect(() => keepalive.close()).not.toThrow();
    expect(() => keepalive.close()).not.toThrow();
    expect(keepalive.getState()).toBeNull();
  });

  it('close() is safe to call while a resume() is still pending', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    keepalive.start(); // resume() in flight, not yet settled
    expect(() => keepalive.close()).not.toThrow();
    expect(keepalive.getState()).toBeNull();
  });
});
