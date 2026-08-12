import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { clearRecordedFailures, recordedFailures } from '../../lib/obs/report';
import { ROUTING_LOSS_GRACE_MS } from './silentKeepalive';

// THE ONE THING THIS FILE EXISTS TO PROVE: routing the song into the
// keepalive's AudioContext (the owner's "one origin" design — the silent tone
// mounted first, the song mixed on top of it in the same graph) must never be
// able to leave the music permanently mute.
//
// The trade that makes that a real risk: the bind is irreversible. There is no
// un-route call, `disconnect()` only deepens the silence, and an element binds
// once per document — so an element routed into a context that dies is an
// element that can never make a sound again. The mixer owns THREE routed slots
// (they rotate through the current/next/prev roles, so every one of them ends
// up audible and every one of them has to be routed), and the escape is a
// FOURTH <audio> element that is never routed. This suite asserts that playback
// actually lands on it, still holding the same track at the same position.
//
// jsdom has no Web Audio and cannot lock an iPhone's screen, so nothing here
// proves the hypothesis the feature is a bet on. What it does prove is the
// property that has to hold whether or not the bet pays: sound keeps coming
// out.

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
  /** Every element ever bound into this graph — i.e. every element that can
   *  no longer be handed back to the speaker. */
  routedElements: unknown[] = [];
  private stateListeners: Array<() => void> = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'statechange') this.stateListeners.push(listener);
  }
  emitState(next: AudioContextState | 'interrupted') {
    this.state = next as AudioContextState;
    for (const listener of this.stateListeners) listener();
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() };
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate };
  }
  createBufferSource() {
    return { buffer: null, loop: false, connect: vi.fn(), start: vi.fn() };
  }
  createMediaElementSource(el: unknown) {
    this.routedElements.push(el);
    return new FakeMediaElementSourceNode();
  }
  /** Set by a test to model an interruption that does not lift: `resume()`
   *  still resolves, the context just never comes back. Off by default,
   *  because a context that never reaches 'running' is itself a failure and
   *  would quietly make every test here run through the escape path. */
  stuckResume = false;
  // Settles on a microtask, like the real asynchronous state machine — a
  // synchronous flip would hide the window in which the graph is mute — and
  // notifies through `emitState`, because a real context fires `statechange`
  // for every transition, including its own resume/suspend. A fake that
  // mutated `.state` silently left a stale grace-window timer armed and made
  // the interruption test unable to observe anything.
  resume = vi.fn(() =>
    Promise.resolve().then(() => {
      if (!this.stuckResume) this.emitState('running');
    }),
  );
  suspend = vi.fn(() =>
    Promise.resolve().then(() => {
      this.emitState('suspended');
    }),
  );
  close = vi.fn(() => Promise.resolve());
}

/** Which element each `play()` landed on, in order. */
let playTargets: HTMLAudioElement[];

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

/** The four physical elements in JSX order: the three mixer slots followed by
 *  the escape. This order is fixed for the lifetime of the document — what
 *  moves is only which slot the engine treats as current/next/prev. */
function audios(): HTMLAudioElement[] {
  return Array.from(document.querySelectorAll('audio'));
}

/** The three mixer slots — the ones routed into the AudioContext. */
function slots(): HTMLAudioElement[] {
  return audios().filter((el) => el.getAttribute('preload') !== 'none');
}

/** The escape element, found by the property that DEFINES it rather than by a
 *  position: it is the only one that must never cost anything until the graph
 *  dies, so it is the only `preload="none"` element in the document. Asking for
 *  a fixed index made this suite silently point at a mixer slot the day a third
 *  slot was inserted ahead of it, and the tests then asserted the escape
 *  properties of an element that is routed. */
function escapeAudio(): HTMLAudioElement {
  const found = audios().filter((el) => el.getAttribute('preload') === 'none');
  expect(found).toHaveLength(1);
  return found[0];
}

function ctx(): FakeAudioContext {
  return FakeAudioContext.instances[0];
}

beforeEach(() => {
  playTargets = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    playTargets.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  clearRecordedFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSession();
});

describe('MusicPlayerProvider — one audio origin', () => {
  it('mounts the song into the same graph as the tone, and only after the tone exists', async () => {
    renderProvider();

    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });

    // One context. The song is inside it, not beside it.
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx().routedElements).toContain(audios()[0]);
  });

  it('routes the promoted element too, so a preloaded track leaves by the same origin', async () => {
    // The mixer rotates which slot holds the `current` role on every advance,
    // so a slot that is merely buffering today is the audible one tomorrow. If
    // only the first one were ever routed, every other track would leave
    // through a second origin — the exact thing this design removes.
    //
    // Two slots, not three, because routing happens when a slot is given a
    // URL: with a two-track queue there is never a `prev` to buffer, so the
    // third slot has nothing to be routed for yet. What matters is that the
    // promoted one was routed BEFORE it became audible, not by which index.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    await act(async () => {
      audios()[0].dispatchEvent(new Event('ended'));
    });

    expect(ctx().routedElements).toContain(audios()[0]);
    expect(ctx().routedElements).toContain(audios()[1]);
  });

  it('never routes the escape element, whatever else happens', async () => {
    // The unlock gesture comes FIRST on purpose. It leaves a `data:` source on
    // the escape element, and a `data:` source is same-origin — so from that
    // moment on the element is perfectly eligible for routing and only the
    // provider's own restraint keeps it out of the graph. A version of this
    // test that skipped the gesture passed even when the provider was mutated
    // to route the escape element explicitly, because a source-less element is
    // refused for an unrelated reason. It proved nothing.
    renderProvider();
    await act(async () => {
      fireEvent.pointerDown(document);
    });
    expect(escapeAudio().getAttribute('src')).toMatch(/^data:/);

    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    await act(async () => {
      audios()[0].dispatchEvent(new Event('ended'));
    });

    expect(ctx().routedElements).not.toContain(escapeAudio());
  });
});

describe('MusicPlayerProvider — escaping a dead audio graph', () => {
  async function playThenKillTheGraph() {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const routed = audios()[0];
    expect(ctx().routedElements).toContain(routed);
    playTargets.length = 0;
    await act(async () => {
      // The browser took the audio session away for good. Every element bound
      // into this context is now mute and unrecoverable.
      ctx().emitState('closed');
    });
    return routed;
  }

  it('KEEPS SOUND COMING OUT: playback moves to an element that was never routed', async () => {
    const routed = await playThenKillTheGraph();
    const escape = escapeAudio();

    expect(playTargets).toContain(escape);
    expect(playTargets).not.toContain(routed);
    // The whole point: the element now making the sound is one the graph
    // never touched, so nothing about the dead context can silence it.
    expect(ctx().routedElements).not.toContain(escape);
  });

  it('carries the same track across, at the position it was interrupted at', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });
    const routed = audios()[0];
    Object.defineProperty(routed, 'currentTime', { configurable: true, value: 73.5 });
    const escape = escapeAudio();
    let seekedTo: number | null = null;
    Object.defineProperty(escape, 'currentTime', {
      configurable: true,
      get: () => seekedTo ?? 0,
      set: (v: number) => {
        seekedTo = v;
      },
    });

    await act(async () => {
      ctx().emitState('closed');
    });
    // The position can only be restored once the element knows the resource's
    // length — before that the assignment is silently dropped.
    await act(async () => {
      escape.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(escape.getAttribute('src')).toContain('videoId=vid-a');
    expect(seekedTo).toBe(73.5);
  });

  it('does not clobber a seek made between the handover and the metadata', async () => {
    // `loadedmetadata` can arrive an arbitrary time after the handover, and
    // the user can move in that window — a lock-screen `seekto` included,
    // whose own effect runs while the element still has no metadata and is
    // therefore dropped by the browser. Replaying the escape-time position
    // when metadata finally lands would silently undo it.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });
    const routed = audios()[0];
    Object.defineProperty(routed, 'currentTime', { configurable: true, value: 10 });
    const escape = escapeAudio();
    let seekedTo: number | null = null;
    Object.defineProperty(escape, 'currentTime', {
      configurable: true,
      get: () => seekedTo ?? 0,
      set: (v: number) => {
        seekedTo = v;
      },
    });

    await act(async () => {
      ctx().emitState('closed');
    });
    await act(async () => {
      api.seek(150);
    });
    await act(async () => {
      escape.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(seekedTo).toBe(150);
  });

  it('reports the handover, with what is known about the escape element', async () => {
    await playThenKillTheGraph();

    const report = recordedFailures().find((f) => f.scope === 'music.player.audioGraphEscape');
    expect(report).toBeDefined();
    expect(report?.message).toBe('context-closed');
    expect((report?.detail as Record<string, unknown> | undefined)?.hasEscapeElement).toBe(true);
    // Whether iOS's autoplay unlock is per-element or per-document has never
    // been determined here. This field is how a real device finally answers
    // it, instead of another round of reasoning from the code.
    expect(report?.detail).toHaveProperty('escapeUnlockPlayed');
  });

  it('stops preloading afterwards — the other mixer slots are captive too', async () => {
    // Buffering into an element that can never be played would spend the
    // session's scarce background network on bytes nobody can hear.
    //
    // Asserted over EVERY slot that is not the one that was playing, rather
    // than over a single hardcoded neighbour: the mixer buffers into two of
    // them at once (`next` and `prev`), so checking only one would leave the
    // other free to keep downloading and still go green.
    const routed = await playThenKillTheGraph();

    for (const slot of slots()) {
      if (slot === routed) continue;
      expect(slot.hasAttribute('src')).toBe(false);
    }
  });

  it('tears the dead context down instead of leaving it beside the escape', async () => {
    await playThenKillTheGraph();

    expect(ctx().close).toHaveBeenCalled();
  });

  it('keeps driving state from the escape element once it is the active one', async () => {
    // Everything else in the provider — MediaSession, the stall watchdog, the
    // queue — reads `audioRef.current`, and every media handler ignores events
    // from any element that is not it. If the handover did not repoint that
    // ref, the escape would play while the app believed nothing was.
    await playThenKillTheGraph();
    const escape = escapeAudio();

    await act(async () => {
      escape.dispatchEvent(new Event('ended'));
    });

    // `ended` on the active element advances the queue; on any other element
    // it is ignored.
    expect(api.current?.itemId).toBe('vid-b');
  });

  it('does not escape while the graph is merely paused by the user', async () => {
    // A pause puts the context in a non-running state ON PURPOSE. Treating
    // that as a dead graph would spend the one-way handover — and with it the
    // whole mixer, whose three slots go captive the moment it fires — on every
    // single pause.
    //
    // The clock has to be driven here, not just the event: the loss is only
    // declared after a grace window, so a version of this test that emitted
    // 'suspended' and asserted immediately passed even with BOTH of the
    // provider's "the user asked for this" guards removed.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });
    playTargets.length = 0;

    await act(async () => {
      api.toggle();
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        ctx().emitState('suspended');
      });
      await act(async () => {
        vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS * 4);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordedFailures().some((f) => f.scope === 'music.player.audioGraphEscape')).toBe(false);
    expect(playTargets).not.toContain(escapeAudio());
  });

  it('escapes on a stuck interruption, once the grace window has passed', async () => {
    // The shape the owner's device actually produces: not a closed context,
    // an interrupted one. Nothing is done until it has been given a chance to
    // come back, and then playback moves.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });
    playTargets.length = 0;

    ctx().stuckResume = true;
    vi.useFakeTimers();
    try {
      await act(async () => {
        ctx().emitState('interrupted');
      });
      expect(playTargets).not.toContain(escapeAudio());
      expect(ctx().resume).toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(ROUTING_LOSS_GRACE_MS + 100);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(playTargets).toContain(escapeAudio());
  });

  it('happens at most once, however many times the context reports failing', async () => {
    await playThenKillTheGraph();
    await act(async () => {
      ctx().emitState('closed');
      ctx().emitState('interrupted');
    });

    expect(
      recordedFailures().filter((f) => f.scope === 'music.player.audioGraphEscape'),
    ).toHaveLength(1);
  });
});

describe('MusicPlayerProvider — when the escape element itself is refused', () => {
  // The case adversarial review put its finger on: `escape.play()` does not
  // run inside a gesture, and if iOS scopes its autoplay unlock per element
  // it will be rejected. What happens next decides whether this is "the music
  // came back when he touched the phone" or something worse.
  function rejectEscapePlay() {
    (HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (this: HTMLMediaElement) {
        playTargets.push(this);
        return this === escapeAudio()
          ? Promise.reject(new DOMException('not allowed', 'NotAllowedError'))
          : Promise.resolve();
      },
    );
  }

  async function escapeIntoARefusal() {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    rejectEscapePlay();
    await act(async () => {
      ctx().emitState('closed');
    });
  }

  it('reports the refusal instead of swallowing it', async () => {
    await escapeIntoARefusal();

    expect(recordedFailures().some((f) => f.scope === 'music.player.escapePlayRejected')).toBe(true);
  });

  it('plays again on the next real interaction', async () => {
    await escapeIntoARefusal();
    const escape = escapeAudio();
    playTargets.length = 0;
    // The refusal is over: the touch that wakes the phone is a gesture.
    (HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (this: HTMLMediaElement) {
        playTargets.push(this);
        return Promise.resolve();
      },
    );

    await act(async () => {
      fireEvent.pointerDown(document);
    });

    expect(playTargets).toContain(escape);
  });

  it('does NOT let the stall watchdog walk the queue through refused tracks', async () => {
    // A rejected play() is not a stall, but the watchdog cannot tell the
    // difference: left armed it would fire `load()`+`play()` on the same
    // still-locked element, fail again, and then SKIP the track — silently
    // marching through the whole queue a track at a time. Disarming it is
    // what keeps a blocked element waiting for a gesture instead.
    //
    // The clock has to be fake BEFORE the escape, because that is when the
    // watchdog is armed. A first version installed fake timers afterwards,
    // advanced them, and passed even with the disarm removed — it was
    // advancing a clock the pending timer was not on.
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    const startedOn = api.current?.itemId;
    rejectEscapePlay();

    vi.useFakeTimers();
    try {
      await act(async () => {
        ctx().emitState('closed');
      });
      await act(async () => {
        // Well past the watchdog's own 40s + 15s budget.
        vi.advanceTimersByTime(120_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(api.current?.itemId).toBe(startedOn);
    expect(recordedFailures().some((f) => f.scope === 'music.player.stallWatchdog')).toBe(false);
  });

  // NO TEST HERE for the retry listeners being detached on unmount, and the
  // absence is deliberate rather than an oversight. Adversarial review
  // flagged them as a leak (the sibling unlock effect cleans up after itself
  // and this path did not), and the cleanup was added — but two attempts to
  // write a test for it both turned out to assert nothing:
  //
  //   - Counting `removeEventListener` calls passes either way, because the
  //     unlock effect removes listeners of exactly the same three types.
  //   - Asserting that a post-unmount touch does not reach the element passes
  //     either way too, because React nulls `audioRef.current` through
  //     `setSlotA(null)` on unmount, and the retry's own `if (!el) return`
  //     guard then swallows it.
  //
  // Which is the real finding: the leaked listener has no observable damage
  // to demonstrate. The cleanup stays because it is correct and free, but it
  // is hygiene, not a fix for anything measured — and a green test claiming
  // otherwise would be worse than no test.
});

describe('MusicPlayerProvider — preparing the escape element', () => {
  it('gives it a gesture-backed play of embedded silence, before anything else plays', async () => {
    // ORDER IS THE SAFETY ARGUMENT. The probe removed in `92b215f` played a
    // second element AFTER the real one and the owner's iPhone reported
    // "playing, but no sound" — WebKit hands the audio route to whoever asked
    // most recently. This one asks first, on `pointerdown`, before the click
    // that starts the song.
    renderProvider();
    const escape = escapeAudio();

    await act(async () => {
      fireEvent.pointerDown(document);
    });
    const unlockIndex = playTargets.indexOf(escape);
    expect(unlockIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });

    const songIndex = playTargets.indexOf(audios()[0]);
    expect(songIndex).toBeGreaterThan(unlockIndex);
  });

  it('uses an embedded clip, so it needs no network at the moment the network is gone', async () => {
    renderProvider();
    const escape = escapeAudio();

    await act(async () => {
      fireEvent.pointerDown(document);
    });

    expect(escape.getAttribute('src')).toMatch(/^data:audio\/wav;base64,/);
  });
});

describe('MusicPlayerProvider — the queue keeps moving after an escape', () => {
  // Both of these are regressions from real defects an adversarial probe found
  // in the mixer wiring, and both had the same shape: the engine deliberately
  // goes inert once the graph is dead, so any code path that asks IT where the
  // sound should go silently stops working — while every indicator stays
  // green. The escape element is not the engine's to manage.

  it('sends the NEXT track to the escape element, not to a captive slot', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    await act(async () => {
      ctx().emitState('closed');
    });
    const escape = escapeAudio();
    expect(escape.getAttribute('src')).toContain('videoId=vid-a');

    await act(async () => {
      api.next();
    });

    // The defect: the engine answers 'unchanged' to everything after an
    // escape, so a caller that only asked the engine left the escape element
    // still holding track A — playback stuck on one song forever.
    expect(escape.getAttribute('src')).toContain('videoId=vid-b');
    expect(api.current?.itemId).toBe('vid-b');
  });

  it('keeps playing through the escape element when a track ends', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    await act(async () => {
      ctx().emitState('closed');
    });
    const escape = escapeAudio();
    playTargets.length = 0;

    await act(async () => {
      escape.dispatchEvent(new Event('ended'));
    });

    // The defect: re-syncing the active element after the auto-advance pointed
    // `audioRef` back at a mixer slot — captive in the dead graph and unable
    // to make a sound — so the queue advanced and nothing played.
    expect(playTargets).toContain(escape);
    expect(playTargets.some((el) => slots().includes(el))).toBe(false);
  });
});
