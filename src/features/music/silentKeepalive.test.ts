import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTING_LOSS_GRACE_MS, createSilentKeepalive } from './silentKeepalive';

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

class FakeMediaElementSourceNode {
  connectedTo: unknown = null;
  connect(target: unknown) {
    this.connectedTo = target;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  sampleRate = 44100;
  destination = {};
  mediaSources: Array<{ el: unknown; node: FakeMediaElementSourceNode }> = [];
  private stateListeners: Array<() => void> = [];

  addEventListener(type: string, listener: () => void) {
    if (type === 'statechange') this.stateListeners.push(listener);
  }
  /** Mirrors the browser: change the state, THEN notify. */
  emitState(next: AudioContextState | 'interrupted') {
    this.state = next as AudioContextState;
    for (const listener of this.stateListeners) listener();
  }
  createMediaElementSource(el: unknown) {
    const node = new FakeMediaElementSourceNode();
    this.mediaSources.push({ el, node });
    return node;
  }
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

// A media element is only ever identified here by the properties
// `routeElement` actually reads, so these tests never need a real DOM.
function fakeElement(src: string): HTMLMediaElement {
  return {
    currentSrc: src,
    getAttribute: (name: string) => (name === 'src' ? src : null),
  } as unknown as HTMLMediaElement;
}

const SAME_ORIGIN = `${window.location.origin}/bff/music/stream?videoId=v-a`;
const CROSS_ORIGIN = 'https://rr3---sn-example.googlevideo.com/videoplayback?id=abc';

describe('createSilentKeepalive — routing the song into the same graph', () => {
  it('feeds the element into the SAME context as the tone, at the same destination', () => {
    // The owner's design in one assertion: one origin. The silence and the
    // song both end at the same `destination` of the same `AudioContext` —
    // not two contexts, not two outputs.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();
    const el = fakeElement(SAME_ORIGIN);

    keepalive.start();
    expect(keepalive.routeElement(el)).toBe(true);

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.mediaSources).toHaveLength(1);
    expect(ctx.mediaSources[0].el).toBe(el);
    expect(ctx.mediaSources[0].node.connectedTo).toBe(ctx.destination);
    // The tone's own path is unchanged and still ends at the same place.
    expect(ctx.lastGain?.gain.value).toBe(0);
    expect(ctx.lastGain?.connect).toHaveBeenCalledWith(ctx.destination);
    expect(keepalive.getRouting(el)).toBe('graph');
  });

  it('refuses to route before a gesture ever built the context', () => {
    // Routing must ride on a context a user gesture brought up. Building one
    // from here would create it outside the gesture, where iOS leaves it
    // suspended — and the bind would be spent on a graph that cannot sound.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();

    expect(keepalive.routeElement(fakeElement(SAME_ORIGIN))).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('refuses a cross-origin source, because routing one is silent and undetectable', () => {
    // `createMediaElementSource` on a cross-origin resource without a
    // matching `crossorigin` attribute SUCCEEDS and then outputs zeros
    // forever, with no error and no event. Refusing keeps the element playing
    // straight out of itself, which is audible.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();
    const el = fakeElement(CROSS_ORIGIN);

    keepalive.start();
    expect(keepalive.routeElement(el)).toBe(false);
    expect(FakeAudioContext.instances[0].mediaSources).toHaveLength(0);
    expect(keepalive.getRouting(el)).toBe('direct');
  });

  it('refuses an element with no source at all', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();
    keepalive.start();

    expect(keepalive.routeElement(fakeElement(''))).toBe(false);
  });

  it('binds an element at most once, however many times it is asked', () => {
    // A second `createMediaElementSource` for the same element throws
    // `InvalidStateError` per spec — and `routeElement` is called on every
    // single play gesture.
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const keepalive = createSilentKeepalive();
    const el = fakeElement(SAME_ORIGIN);
    keepalive.start();

    expect(keepalive.routeElement(el)).toBe(true);
    expect(keepalive.routeElement(el)).toBe(true);
    expect(keepalive.routeElement(el)).toBe(true);
    expect(FakeAudioContext.instances[0].mediaSources).toHaveLength(1);
  });

  it('leaves the element playing directly when the browser refuses the bind', () => {
    class RefusingAudioContext extends FakeAudioContext {
      createMediaElementSource(): FakeMediaElementSourceNode {
        throw new DOMException('already connected', 'InvalidStateError');
      }
    }
    vi.stubGlobal('AudioContext', RefusingAudioContext);
    const onRoutingLost = vi.fn();
    const keepalive = createSilentKeepalive({ onRoutingLost });
    const el = fakeElement(SAME_ORIGIN);
    keepalive.start();

    expect(keepalive.routeElement(el)).toBe(false);
    expect(keepalive.getRouting(el)).toBe('direct');
    // Nothing was ever captive, so there is nothing to escape from — telling
    // the caller to abandon its elements here would cost double buffering for
    // no reason at all.
    expect(onRoutingLost).not.toHaveBeenCalled();
  });
});

describe('createSilentKeepalive — losing the graph while it carries the song', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A context whose `resume()` never brings it back — an interruption that
   *  does not end, which is the case the escape exists for. */
  class StuckAudioContext extends FakeAudioContext {
    resumeMock = vi.fn(() => Promise.resolve());
  }

  function routedKeepalive(onRoutingLost: () => void) {
    vi.stubGlobal('AudioContext', StuckAudioContext);
    const keepalive = createSilentKeepalive({ onRoutingLost });
    keepalive.start();
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'running';
    keepalive.routeElement(fakeElement(SAME_ORIGIN));
    return { keepalive, ctx };
  }

  it('reports the loss when an interruption does not lift, so the caller can escape', () => {
    const onRoutingLost = vi.fn();
    const { ctx } = routedKeepalive(onRoutingLost);

    ctx.emitState('interrupted');
    // It asks for the session back FIRST — a phone call ending is routinely
    // recoverable and must not cost the session its double buffering.
    expect(ctx.resumeMock).toHaveBeenCalled();
    expect(onRoutingLost).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS + 100);

    expect(onRoutingLost).toHaveBeenCalledTimes(1);
    expect(onRoutingLost).toHaveBeenCalledWith('context-interrupted');
  });

  it('stays quiet when the interruption lifts inside the grace window', () => {
    const onRoutingLost = vi.fn();
    const { ctx } = routedKeepalive(onRoutingLost);

    ctx.emitState('interrupted');
    ctx.emitState('running');
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS + 100);

    expect(onRoutingLost).not.toHaveBeenCalled();
  });

  it('reports a closed context immediately — no grace window can revive one', () => {
    const onRoutingLost = vi.fn();
    const { ctx } = routedKeepalive(onRoutingLost);

    ctx.emitState('closed');

    expect(onRoutingLost).toHaveBeenCalledWith('context-closed');
  });

  it('does not mistake the user pausing for the graph dying', () => {
    // `suspend()` puts the context in a non-running state ON PURPOSE. A graph
    // that is silent because nobody asked for sound has not failed, and
    // escaping here would spend the one-way handover on an ordinary pause.
    const onRoutingLost = vi.fn();
    const { keepalive, ctx } = routedKeepalive(onRoutingLost);

    keepalive.suspend();
    ctx.emitState('suspended');
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS * 4);

    expect(onRoutingLost).not.toHaveBeenCalled();
  });

  it('says nothing when the context dies with no element captive in it', () => {
    // Same event, completely different meaning: with nothing routed, a dead
    // context costs the caller nothing — every element is still playing out
    // of itself.
    vi.stubGlobal('AudioContext', StuckAudioContext);
    const onRoutingLost = vi.fn();
    const keepalive = createSilentKeepalive({ onRoutingLost });
    keepalive.start();
    const ctx = FakeAudioContext.instances[0];

    ctx.emitState('interrupted');
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS * 4);

    expect(onRoutingLost).not.toHaveBeenCalled();
    expect(keepalive.isRoutingLost()).toBe(false);
  });

  it('notices a context that was ALREADY interrupted when playback resumed', () => {
    // No `statechange` fires for a state that did not change. Without an
    // explicit check on `start()`, a graph that went interrupted while the
    // user was paused would swallow the next song in total silence with
    // nothing ever looking at it.
    const onRoutingLost = vi.fn();
    const { keepalive, ctx } = routedKeepalive(onRoutingLost);
    keepalive.suspend();
    ctx.state = 'interrupted';

    keepalive.start();
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS + 100);

    expect(onRoutingLost).toHaveBeenCalledTimes(1);
  });

  it('goes inert after the loss instead of rebuilding a graph it cannot fill', () => {
    // A replacement context cannot take the captive element back (one bind
    // per document, forever), so rebuilding would produce a context carrying
    // silence while the song stays mute in the dead one — and would report a
    // healthy 'running' state to the diagnostics on top of it.
    const onRoutingLost = vi.fn();
    const { keepalive, ctx } = routedKeepalive(onRoutingLost);

    ctx.emitState('closed');
    expect(keepalive.isRoutingLost()).toBe(true);

    keepalive.start();

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(keepalive.routeElement(fakeElement(SAME_ORIGIN))).toBe(false);
    expect(onRoutingLost).toHaveBeenCalledTimes(1);
  });

  it('never reports the loss twice, however many transitions arrive', () => {
    const onRoutingLost = vi.fn();
    const { ctx } = routedKeepalive(onRoutingLost);

    ctx.emitState('interrupted');
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS + 100);
    ctx.emitState('closed');
    ctx.emitState('interrupted');
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS * 4);

    expect(onRoutingLost).toHaveBeenCalledTimes(1);
  });

  it('does not treat its own close() as the browser taking the session away', () => {
    const onRoutingLost = vi.fn();
    const { keepalive, ctx } = routedKeepalive(onRoutingLost);

    keepalive.close();
    ctx.emitState('closed');
    vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS * 4);

    expect(onRoutingLost).not.toHaveBeenCalled();
  });

  it('cannot break playback when the escape handler itself throws', () => {
    const { ctx } = routedKeepalive(() => {
      throw new Error('escape handler blew up');
    });

    expect(() => ctx.emitState('closed')).not.toThrow();
  });
});
