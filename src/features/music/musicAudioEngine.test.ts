import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMusicAudioEngine } from './musicAudioEngine';

// The contract this suite is about, in one line: THE ELEMENT THAT IS PLAYING
// NEVER HAS ITS `src` REASSIGNED. Everything else here — role rotation, gain
// ordering, one context for four sources — exists to make that possible, and
// each is asserted as its own guarantee rather than inferred from the whole.
//
// jsdom implements neither Web Audio nor HTMLMediaElement playback, so both
// are faked. The fakes mirror only what the engine actually touches, and they
// RECORD rather than pretend: `srcAssignments` counts every write, because a
// test that merely checks the final `src` value cannot tell a slot that was
// never reassigned from one that was reassigned back to the same URL — and
// that difference is the entire bug.

class FakeGainNode {
  gain = { value: 1 };
  connect = vi.fn();
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
  currentTime = 0;
  destination = {};
  mediaSources: Array<{ el: unknown; node: FakeMediaElementSourceNode }> = [];
  gains: FakeGainNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  addEventListener() {}
  createMediaElementSource(el: unknown) {
    const node = new FakeMediaElementSourceNode();
    this.mediaSources.push({ el, node });
    return node;
  }
  createGain() {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate };
  }
  createBufferSource() {
    return { buffer: null, loop: false, connect: vi.fn(), start: vi.fn() };
  }
  resume = vi.fn(() => Promise.resolve().then(() => void (this.state = 'running')));
  suspend = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
}

/** Only the surface the engine touches. `src` is a real accessor so an
 *  assignment can be counted — the thing every test here ultimately asks. */
class FakeAudioElement {
  srcAssignments: string[] = [];
  loadCalls = 0;
  pauseCalls = 0;
  paused = true;
  currentTime = 0;
  private value = '';

  get src() {
    return this.value;
  }
  set src(next: string) {
    this.value = next;
    this.srcAssignments.push(next);
  }
  /** What `isSameOriginSource` reads first; the browser resolves it to an
   *  absolute URL, and the engine's own bookkeeping must not depend on that. */
  get currentSrc() {
    return this.value ? new URL(this.value, window.location.href).href : '';
  }
  getAttribute(name: string) {
    return name === 'src' && this.value ? this.value : null;
  }
  hasAttribute(name: string) {
    return name === 'src' && Boolean(this.value);
  }
  removeAttribute(name: string) {
    if (name === 'src') this.value = '';
  }
  load() {
    this.loadCalls += 1;
  }
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

const A = '/bff/music/stream?videoId=a';
const B = '/bff/music/stream?videoId=b';
const C = '/bff/music/stream?videoId=c';
const D = '/bff/music/stream?videoId=d';

function makeEngine() {
  const els = [new FakeAudioElement(), new FakeAudioElement(), new FakeAudioElement()];
  const engine = createMusicAudioEngine();
  engine.attach(els as unknown as HTMLAudioElement[]);
  return { engine, els };
}

/** The gain node the graph built for a given element, found by following the
 *  actual topology rather than by index: the silent tone builds a gain node of
 *  its own before any element is routed, so positional bookkeeping between
 *  `mediaSources` and `gains` does not line up. Reading what the element's
 *  source node is CONNECTED to also asserts the shape of the graph — element
 *  -> its own gain -> destination — which an index lookup never would. */
function gainFor(ctx: FakeAudioContext, el: FakeAudioElement): FakeGainNode | undefined {
  const entry = ctx.mediaSources.find((source) => source.el === el);
  const target = entry?.node.connectedTo;
  return target instanceof FakeGainNode ? target : undefined;
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMusicAudioEngine — the no-reassignment rule', () => {
  it('promotes the preloaded next track without ever touching the playing element', () => {
    const { engine, els } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });

    const playing = engine.getCurrent() as unknown as FakeAudioElement;
    const assignmentsBefore = playing.srcAssignments.length;

    const outcome = engine.setCurrentUrl(B);

    expect(outcome).toBe('promoted-next');
    // The element that WAS playing got no new src — it became `prev`, still
    // holding A, still buffered, ready for an instant step back.
    expect(playing.srcAssignments.length).toBe(assignmentsBefore);
    expect(engine.getUrl('prev')).toBe(A);
    // And the new current is the element that had already buffered B.
    expect(engine.getCurrent()).not.toBe(playing as unknown as HTMLAudioElement);
    expect(engine.getUrl('current')).toBe(B);
    // Nobody reloaded anything: three elements, three loads, one per track.
    expect(els.reduce((sum, el) => sum + el.srcAssignments.length, 0)).toBe(2);
  });

  it('steps back into the preloaded previous track just as cheaply', () => {
    const { engine } = makeEngine();
    engine.setCurrentUrl(B);
    engine.resume();
    engine.setNeighbourUrls({ next: C, prev: A });

    const playing = engine.getCurrent() as unknown as FakeAudioElement;
    const before = playing.srcAssignments.length;

    expect(engine.setCurrentUrl(A)).toBe('promoted-prev');
    expect(playing.srcAssignments.length).toBe(before);
    expect(engine.getUrl('current')).toBe(A);
    // The outgoing track becomes the one ahead of us again.
    expect(engine.getUrl('next')).toBe(B);
  });

  it('loads a JUMP onto a neighbour, never onto the element that is sounding', () => {
    // The rule has to hold for jumps too, and this is the test that was
    // missing when adversarial review found it broken: somebody must load a
    // track no slot had buffered, but it must not be the element producing
    // sound — that `emptied` -> `load` -> `play` sequence is the exact window
    // the whole design exists to remove, and a jump is no less subject to it
    // than an auto-advance.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });

    const playing = engine.getCurrent() as unknown as FakeAudioElement;
    playing.paused = false;
    const before = playing.srcAssignments.length;

    // A jump to an unrelated track — neither neighbour holds it.
    expect(engine.setCurrentUrl(D)).toBe('loaded');
    expect(engine.getUrl('current')).toBe(D);
    // The sounding element was not touched; it became `prev`, still holding A.
    expect(playing.srcAssignments.length).toBe(before);
    expect(engine.getUrl('prev')).toBe(A);
    expect(playing.pauseCalls).toBe(0);
  });

  it('loads straight onto the current slot when nothing is playing yet', () => {
    // The first track of a session has nothing to protect.
    const { engine } = makeEngine();
    expect(engine.setCurrentUrl(A)).toBe('loaded');
    const current = engine.getCurrent() as unknown as FakeAudioElement;
    expect(current.srcAssignments).toEqual([A]);
  });

  it('reports an unchanged current instead of reloading the same URL', () => {
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    const playing = engine.getCurrent() as unknown as FakeAudioElement;

    expect(engine.setCurrentUrl(A)).toBe('unchanged');
    expect(playing.srcAssignments).toEqual([A]);
  });

  it('leaves the current slot loaded when the queue hands it no playable URL', () => {
    // A track with no resolvable source must not cost the session its graph
    // membership: an element with no src cannot be routed, and cannot sound.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    const playing = engine.getCurrent() as unknown as FakeAudioElement;

    expect(engine.setCurrentUrl(null)).toBe('unchanged');
    expect(playing.src).toBe(A);
    expect(engine.getRouting(playing as unknown as HTMLAudioElement)).toBe('graph');
  });
});

describe('createMusicAudioEngine — one graph, four sources', () => {
  it('routes every slot into the same context, not one context each', () => {
    const { engine, els } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: C });

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.mediaSources).toHaveLength(3);
    for (const el of els) {
      expect(engine.getRouting(el as unknown as HTMLAudioElement)).toBe('graph');
    }
  });

  it('keeps exactly one slot audible and the rest at zero', () => {
    const { engine, els } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: C });

    const ctx = FakeAudioContext.instances[0];
    const current = engine.getCurrent() as unknown as FakeAudioElement;
    for (const el of els) {
      expect(gainFor(ctx, el)?.gain.value).toBe(el === current ? 1 : 0);
    }
  });

  it('routes a slot that only received its source after the gesture', () => {
    // `routeElement` refuses an element with nothing loaded — so a neighbour
    // that was empty at resume() time must still get bound once it is given
    // something, or it would sound out of its own output when promoted.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.mediaSources).toHaveLength(1);

    engine.setNeighbourUrls({ next: B, prev: null });
    expect(ctx.mediaSources).toHaveLength(2);
    expect(engine.getRouting(engine.getElement('next'))).toBe('graph');
  });

  it('hands the incoming track its gain before the outgoing one is paused', () => {
    // The ordering IS the fix: if the outgoing element stopped first, the mix
    // would carry nothing but the silent tone for that instant, and an instant
    // of no real audio is the window iOS reclaims the session in.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });

    const outgoing = engine.getCurrent() as unknown as FakeAudioElement;
    outgoing.paused = false;

    engine.setCurrentUrl(B);

    const ctx = FakeAudioContext.instances[0];
    const incoming = engine.getCurrent() as unknown as FakeAudioElement;
    // Rotation alone made the incoming element audible, and did NOT stop the
    // outgoing one — pausing it is a separate, later step.
    expect(gainFor(ctx, incoming)?.gain.value).toBe(1);
    expect(gainFor(ctx, outgoing)?.gain.value).toBe(0);
    expect(outgoing.pauseCalls).toBe(0);

    engine.silenceNeighbours();
    expect(outgoing.pauseCalls).toBe(1);
  });
});

describe('createMusicAudioEngine — neighbours', () => {
  it('never assigns a source to the slot that is playing', () => {
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    const playing = engine.getCurrent() as unknown as FakeAudioElement;

    engine.setNeighbourUrls({ next: B, prev: C });
    engine.setNeighbourUrls({ next: C, prev: D });

    expect(playing.srcAssignments).toEqual([A]);
  });

  it('refuses to buffer the track that is already playing on another slot', () => {
    // Two elements holding one URL is two concurrent GETs for one track — and
    // on a Jellyfin DirectPlay URL, two server-side playback sessions.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();

    engine.setNeighbourUrls({ next: A, prev: A });

    expect(engine.getUrl('next')).toBeNull();
    expect(engine.getUrl('prev')).toBeNull();
  });

  it('releases a slot that is no longer adjacent', () => {
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });
    const held = engine.getElement('next') as unknown as FakeAudioElement;
    held.paused = false;

    engine.setNeighbourUrls({ next: null, prev: null });

    expect(engine.getUrl('next')).toBeNull();
    // Paused before release: an element still fetching a resource it is about
    // to drop keeps the connection open until the load algorithm notices.
    expect(held.pauseCalls).toBe(1);
    expect(held.src).toBe('');
  });
});

describe('createMusicAudioEngine — after the graph dies', () => {
  it('stops rotating and stops preloading once the caller has escaped', () => {
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });

    const held = engine.getElement('next') as unknown as FakeAudioElement;

    engine.markEscaped();

    // Escaping releases the neighbours: they hold buffered bytes for tracks
    // that can never sound through this graph, and a held resource keeps its
    // connection open — network the escape element now needs for itself.
    expect(engine.getUrl('next')).toBeNull();
    expect(held.src).toBe('');

    // The three slots are captive in a graph that cannot sound; promoting or
    // loading one would hand the track to a mute element. The caller owns the
    // escape element from here on.
    const current = engine.getCurrent() as unknown as FakeAudioElement;
    const assignments = current.srcAssignments.length;
    expect(engine.setCurrentUrl(B)).toBe('unchanged');
    expect(current.srcAssignments.length).toBe(assignments);

    engine.setNeighbourUrls({ next: C, prev: D });
    expect(engine.getUrl('next')).toBeNull();
    expect(engine.isEscaped()).toBe(true);
  });
});

describe('createMusicAudioEngine — the tone', () => {
  it('starts on resume and is never suspended by the engine itself', () => {
    // The tone is the floor the whole design stands on: the ONLY thing that
    // stops it is `close()`, which the caller reserves for unmount or a long
    // idle timeout. There is deliberately no per-pause suspend.
    const { engine } = makeEngine();
    engine.resume();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.suspend).not.toHaveBeenCalled();

    engine.close();
    expect(ctx.close).toHaveBeenCalled();
  });

  it('survives an environment with no Web Audio at all', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const { engine } = makeEngine();

    expect(() => {
      engine.resume();
      engine.setCurrentUrl(A);
      engine.setNeighbourUrls({ next: B, prev: C });
      engine.setCurrentUrl(B);
      engine.silenceNeighbours();
    }).not.toThrow();
    // Roles still rotate — they just are not mixed, and each element plays
    // straight out of itself.
    expect(engine.getUrl('current')).toBe(B);
  });
});

describe('createMusicAudioEngine — the defects adversarial review found', () => {
  it('re-attaching the same three elements after a rotation changes nothing', () => {
    // `attach` compared positionally, so re-attaching the SAME three nodes in
    // the same order clobbered the live roles — and because the third slot
    // kept whatever gain it had, that left TWO elements audible at once. A
    // StrictMode double-mount or an HMR pass is all it takes to reach.
    const { engine, els } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });
    engine.setCurrentUrl(B); // rotate: roles no longer match JSX order

    const audible = engine.getCurrent();
    engine.attach(els as unknown as HTMLAudioElement[]);

    expect(engine.getCurrent()).toBe(audible);
    expect(engine.getUrl('current')).toBe(B);
    const ctx = FakeAudioContext.instances[0];
    const loud = els.filter((el) => gainFor(ctx, el)?.gain.value === 1);
    expect(loud).toHaveLength(1);
  });

  it('refuses an attach that would give one element two roles', () => {
    const shared = new FakeAudioElement();
    const other = new FakeAudioElement();
    const engine = createMusicAudioEngine();
    engine.attach([shared, shared, other] as unknown as HTMLAudioElement[]);

    // Nothing adopted: there is no arrangement of three roles over two nodes.
    expect(engine.getCurrent()).toBeNull();
  });

  it('drops its references when every ref comes back null', () => {
    const { engine } = makeEngine();
    engine.attach([null, null, null]);
    expect(engine.getCurrent()).toBeNull();
  });

  it('never lets next and prev hold the same track', () => {
    // A two-track queue on repeat-all asks for the same URL in both
    // directions. Loading it twice is two concurrent GETs, and on a Jellyfin
    // DirectPlay URL two server-side playback sessions for one listen.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();

    engine.setNeighbourUrls({ next: B, prev: B });

    expect(engine.getUrl('next')).toBe(B);
    expect(engine.getUrl('prev')).toBeNull();
  });

  it('stops trusting a slot whose load failed', () => {
    // The engine records what it ASKED each element to hold; an element whose
    // fetch died still looks buffered from the inside. Without this it would
    // be rotated into, play nothing, and then answer 'unchanged' forever —
    // permanent silence with the bookkeeping all green.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    engine.setNeighbourUrls({ next: B, prev: null });

    engine.invalidateElement(engine.getElement('next'));

    expect(engine.getUrl('next')).toBeNull();
    // And it is no longer promoted as if it were ready.
    expect(engine.setCurrentUrl(B)).toBe('loaded');
  });

  it('never rebuilds the graph after close — the slots are captive in the dead one', () => {
    // `close()` does not release the elements bound to the context. Rebuilding
    // would produce a live graph carrying nothing while all three slots stay
    // mute in the closed one, with no error, no event, and routing loss never
    // reported: total silence with every indicator green.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();
    expect(FakeAudioContext.instances).toHaveLength(1);

    engine.close();
    engine.resume();

    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('declaring no playback intent does not suspend the tone', () => {
    // Intent and the tone are different things: the tone keeps the audio
    // session, while intent is what stops an OS interruption during a user
    // pause from being read as the graph failing.
    const { engine } = makeEngine();
    engine.setCurrentUrl(A);
    engine.resume();

    engine.setPlaybackIntent(false);

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.suspend).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
  });
});
