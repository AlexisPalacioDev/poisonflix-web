// Silent Web Audio keepalive: a background, inaudible audio graph that stays
// alive for as long as a track is actually playing, so iOS never sees this
// tab's audio session go fully quiet in the gap between one track ending and
// the next one's bytes actually arriving.
//
// THE MEASUREMENT THIS IS A REASONED BET ON (see MusicPlayerProvider's own
// `STALL_WATCHDOG_MS` docstring for the full detail): 31 real on-device traces
// (iPhone, iOS 18.7 Safari), 21 auto-advances with the screen locked, 11 hung
// every time with the identical shape — `play` -> `waiting` -> `stalled
// (ready=0)` -> `stalled (ready=1)` -> 60-110s of total silence, no further
// event of any kind, no `error`. Three server-log cross-checks ruled the
// backend out (one file was pre-warmed and ready 12s BEFORE `play()` and it
// still hung 89s) — the freeze is the tab's own network/media pipeline going
// dark in the background, not the server. The gap between tracks is exactly
// when nothing is audible, and that is exactly when the hang happens. Keeping
// *something* audible-to-the-OS (even though it is silent to the ear) through
// that gap is the hypothesis here — it has never been verified against the
// owner's device, and this file does not claim it fixes the hang.
//
// WHY WEB AUDIO API AND NOT A SECOND <audio> ELEMENT: this codebase's own
// double-buffering preload element (see MusicPlayerProvider's `promoteFromPreload`
// and the belt-and-suspenders unlock probe) is itself proof of how easily iOS
// reshuffles which element owns the single "media session" a page gets — a
// probe playing MUTED on the preload element already has explicit comments
// worrying about it stealing audio focus from the active one. A genuinely
// SOUNDING second <audio> element competing for that same one-session budget
// risks pausing the track the user actually wants to hear — i.e. causing the
// exact bug this feature exists to work around. A Web Audio API graph
// (AudioContext -> GainNode fixed at 0 -> a looping AudioBufferSourceNode) is
// not an HTMLMediaElement at all, so it never becomes a candidate for "the"
// active media element the way a second `<audio>` would. UNPROVEN, and stated
// only that narrowly: WebKit does still model an `AudioContext` as its own
// kind of media-session participant internally, and whether that
// participation can ever influence which HTMLMediaElement iOS treats as
// active is not something this codebase can verify without a real device
// trace. What IS certain is that this graph cannot literally pause the real
// `<audio>` element by winning "only one element can play" the way a second,
// audible `<audio>` element could — that specific failure mode is closed.

// ── ONE AUDIO ORIGIN (the owner's design) ────────────────────────────────
//
// Everything above describes the graph while it carried ONLY silence. That
// left the OS looking at two independent sources for one song: the `<audio>`
// element and this context. `routeElement` closes that gap — the playing
// element's output is fed INTO this same context (`createMediaElementSource`
// -> destination), alongside the zero-gain tone. One origin, never quiet,
// because the tone is mounted first and the song is mixed on top of it.
//
// The extra reason to want it: an on-device measurement showed this context
// flipping to `'interrupted'` the moment the page went `hidden:true`, while
// it carried nothing but silence. Carrying the actual song may give iOS less
// reason to interrupt it. PLAUSIBLE, NOT PROVEN — no device trace confirms
// either half of that sentence, and the opposite outcome (it interrupts
// anyway, and now takes the song down with it) is exactly what
// `onRoutingLost` exists for.
//
// THE DANGER THIS MODULE HAS TO CARRY, stated plainly because it is the whole
// reason for the machinery below: routing is EFFECTIVELY IRREVERSIBLE.
//
//   1. Per spec, "once an HTMLMediaElement has been routed to a
//      MediaElementAudioSourceNode, playback of the HTMLMediaElement will be
//      re-routed into the processing graph of the AudioContext". There is no
//      un-route operation. `disconnect()` therefore does NOT hand the element
//      back to the default output — it makes the element SILENT. This module
//      deliberately exposes no "unroute"/"bypass" call, because there is no
//      honest way to implement one and a method with that name would read as
//      an escape hatch that does the opposite of what it says.
//   2. An element can be bound ONCE, for the lifetime of the document. A
//      second `createMediaElementSource` for the same element throws
//      `InvalidStateError`, including from a DIFFERENT context — so once the
//      context that owns the binding dies, that element has no way back.
//
// Which is why the real escape does not live here at all: this module only
// reports that the graph can no longer carry sound (`onRoutingLost`), and
// MusicPlayerProvider hands playback to a physically DIFFERENT <audio>
// element that was deliberately never routed. See its `escapeFromAudioGraph`.
//
// CORS: a cross-origin resource without a matching `crossorigin` attribute
// feeds the graph SILENCE, with no error and no event. `routeElement` refuses
// any element whose current source is not same-origin, because that failure
// is undetectable once it happens — but note the refusal only sees the source
// loaded AT THAT MOMENT. The caller owns the stronger guarantee that every
// later source is same-origin too; see `isSameOriginMedia` in
// MusicPlayerProvider.tsx.

export type KeepaliveContextState = AudioContextState | null;

/** Where an element's sound currently leaves: through this graph, or straight
 *  out of the element itself. Reported into the lock diagnostics trace —
 *  without it, a trace of a silent-but-advancing track cannot say which of the
 *  two paths was even in play. */
export type AudioRouting = 'graph' | 'direct';

export interface SilentKeepaliveOptions {
  /**
   * Called at most once, when the context has stopped carrying sound and
   * cannot be brought back (see the irreversibility note above). The caller
   * MUST respond by moving playback to an element this handle has never
   * routed; nothing this module can do will make the routed one audible
   * again. Never fires while nothing is routed — with no element captive,
   * a dead context costs nothing and the caller has nothing to escape from.
   */
  onRoutingLost?: (reason: string) => void;
  /** Diagnostic sink for routing/context transitions. */
  onEvent?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface SilentKeepaliveHandle {
  /**
   * Best-effort start/resume. Safe to call every time real playback begins
   * (idempotent: builds the graph once, then only resumes an already-built
   * context — or rebuilds if the browser closed it out from under us, e.g.
   * Safari's `'interrupted'`/`'closed'` states from a phone call or route
   * change). Must be called synchronously from inside a user gesture the
   * FIRST time in a session — an `AudioContext` is born `suspended` on iOS
   * and can only move to `running` from one. Every browser call this makes
   * (`resume()`, node construction) is wrapped against BOTH a synchronous
   * throw and a rejected promise, and none of it is awaited: this function
   * must return immediately so a caller in the middle of the
   * gesture-synchronous `playImperative` path (see MusicPlayerProvider.tsx)
   * never delays the real `<audio>` element's own synchronous `play()` call,
   * which iOS requires to run in the same call stack as the gesture, and
   * never THROWS into that same call stack either — see below, this was a
   * real bug caught by adversarial review: an unguarded `ctx.resume()` can
   * throw synchronously (not just reject) on some legacy `webkitAudioContext`
   * shapes, which would have aborted `playImperative` mid-function, before it
   * ever reached the real element's `.then()/.catch()` registration.
   */
  start(): void;
  /**
   * Suspends the context (silences the graph, stops it consuming CPU/battery)
   * without tearing it down — a later `start()` then only needs to resume,
   * not rebuild, so it does not depend on a fresh gesture the second time
   * around. Call when real playback stops (user pause, or the queue running
   * out), never left running for its own sake. Deliberately does NOT gate on
   * reading `ctx.state` first (an earlier version did, and adversarial review
   * found the race: `AudioContext.state` only flips once its own promise
   * settles, so a rapid pause->resume->pause could see a stale 'suspended'
   * read here and skip the call entirely, leaving the context silently
   * running after the user paused). The Web Audio spec queues `resume()` and
   * `suspend()` as ordered "control messages" on the same context, so issuing
   * this unconditionally and letting the browser serialize it against
   * whatever `start()` calls interleave with it is correct where reading our
   * own stale snapshot of `.state` was not.
   */
  suspend(): void;
  /**
   * Declare whether the caller currently WANTS sound, without touching the
   * context at all.
   *
   * `suspend()` conflates two things that only look alike: it silences the
   * graph AND it records that a non-running context is expected rather than
   * broken (`evaluateHealth` exempts a context that nobody asked to be
   * running). A mixer that keeps its tone alive through a pause — so the OS
   * never sees the page go quiet — still needs the second half: without it,
   * `wantSound` stays true forever after the first `start()`, and iOS
   * interrupting the context while the user has it PAUSED (measured: it
   * interrupts the moment the page goes `hidden`) reads as a routing failure.
   * The caller then burns its one-way escape on a session nobody was even
   * listening to.
   *
   * So: `setPlaybackIntent(false)` on pause, `true` when playback resumes.
   * Never suspends, never resumes, never builds anything.
   */
  setPlaybackIntent(wanted: boolean): void;
  /**
   * Tears the context down for good. Call on provider unmount only.
   *
   * TERMINAL once anything has been routed, and that is not a stylistic
   * choice: closing a context does NOT release the elements bound to it (an
   * element binds once per document, full stop — see the note at the top of
   * this file). A later rebuild would produce a live context carrying nothing,
   * while every real element sits mute in the dead one — silence with no
   * error, no event, and `isRoutingLost()` still reporting false. So a handle
   * that has carried elements refuses to build again after `close()`.
   */
  close(): void;
  /**
   * Current `AudioContext` state, or `null` when no Web Audio support exists
   * or graph construction failed. Feeds `useLockDiagnostics` so a stalled
   * trace can say whether the keepalive was actually running at the time —
   * without this, the exact question a real hang will raise ("was the
   * keepalive even alive when it died?") has no answer.
   */
  getState(): KeepaliveContextState;
  /**
   * Feed `el`'s output into this graph, so the song and the silent tone leave
   * through one origin instead of two. Returns true when the element is (or
   * already was) carried by the graph, false when it was left alone and keeps
   * playing straight out of itself.
   *
   * IRREVERSIBLE ON SUCCESS — read this module's "ONE AUDIO ORIGIN" note
   * before calling. Refusing is always the safe outcome: an element that was
   * never routed is an element that can still be played normally.
   *
   * Refuses (returns false, changes nothing) when: there is no context yet
   * (`start()` has not run), routing has already been lost, the element's
   * current source is not same-origin (a cross-origin source would feed the
   * graph pure silence with no error), or the browser throws. Calling it again
   * for an element already routed is a no-op that returns true.
   *
   * Must be safe to call from inside the gesture-synchronous `playImperative`
   * path: like every other method here it never throws and never awaits.
   *
   * `options.gain` inserts a per-element `GainNode` between the element and the
   * destination, so several routed elements can share one context while only
   * the chosen one is audible (see `musicAudioEngine`, which routes the
   * current/next/prev slots into this same graph). Omitting it keeps the
   * original unity-connect behaviour — element -> destination, nothing in
   * between — which is what the "no gain node of our own" measurement below
   * covers. A ROLE gain of exactly 0 or 1 does not double-apply the user's
   * volume slider the way an arbitrary gain would: the element's own
   * `volume`/`muted` are still the only thing scaling the signal when the role
   * gain is 1, and when it is 0 the element is meant to be inaudible anyway.
   */
  routeElement(el: HTMLMediaElement, options?: { gain?: number }): boolean;
  /**
   * Set an already-routed element's role gain (0 = inaudible, 1 = full).
   * Returns false when the element was never routed WITH a gain node, in which
   * case nothing changed — an element routed at unity has no gain node to move
   * and silencing it is the caller's job (`pause()`).
   *
   * Ramps over a few milliseconds rather than stepping: an instantaneous jump
   * between 0 and 1 on a signal that is mid-waveform is a discontinuity, and a
   * discontinuity in a sample stream is an audible click.
   */
  setElementGain(el: HTMLMediaElement, value: number): boolean;
  /** Whether `el`'s sound currently leaves through this graph. Diagnostics. */
  getRouting(el: HTMLMediaElement | null | undefined): AudioRouting;
  /** True once `onRoutingLost` has fired. The handle is inert from then on. */
  isRoutingLost(): boolean;
}

// One second of silence is enough to loop forever — a longer buffer buys
// nothing (it is silent either way) and only costs more memory up front.
const SILENT_BUFFER_SECONDS = 1;

// How long a routed graph is allowed to sit in a non-running state, while
// playback is supposed to be sounding, before it is declared lost and the
// caller is told to escape.
//
// Two failure directions to balance, and this constant cannot be right for
// both without a device measurement that does not exist yet:
//   - Too short: an ordinary, recoverable interruption (a phone call, an
//     audio route change) triggers a permanent handover to the escape element
//     and costs the session its double buffering for nothing.
//   - Too long: the song stays silently routed into a dead context for that
//     entire window, which is dead air the listener hears.
// 1.5s is chosen for the second one, because silence is the failure the owner
// actually reported and a lost double buffer is not. Deliberately NOT tuned
// against the "interrupted the instant hidden:true" measurement — that was
// taken with the graph carrying only silence, and whether it repeats with the
// song routed is the single unknown this whole feature is a bet on.
//
// Load-bearing caveat, stated because it limits what this can promise: a
// backgrounded iOS tab throttles timers hard, so this timer may fire far
// later than 1.5s — or, if the tab is fully frozen, not at all. Every
// `statechange` re-evaluates as well, so recovery does not depend on the
// timer alone, but a frozen tab is the one case nothing in this file can
// reach.
export const ROUTING_LOSS_GRACE_MS = 1_500;

// Seconds a role gain takes to travel between 0 and 1. Long enough that the
// sample stream has no step discontinuity in it (that is what a click IS),
// short enough that a listener pressing "next" does not perceive a fade —
// 20ms is roughly one waveform period at the bottom of human hearing, so
// nothing musical survives inside the ramp.
const GAIN_RAMP_SECONDS = 0.02;

/**
 * Whether `el`'s currently loaded source is same-origin, and therefore safe to
 * feed into a graph. A cross-origin resource loaded without a matching
 * `crossorigin` attribute is not an error case — `createMediaElementSource`
 * succeeds and then silently outputs zeros forever, with no event to detect
 * it. `data:` sources are never a tainting risk and count as safe.
 *
 * Reads `currentSrc` (what the element actually resolved and is playing) and
 * falls back to `src`. An empty source is treated as unsafe: there is nothing
 * to verify, so there is nothing to justify a permanent, irreversible bind.
 */
function isSameOriginSource(el: HTMLMediaElement): boolean {
  try {
    const raw = el.currentSrc || el.getAttribute('src') || '';
    if (!raw) return false;
    if (raw.startsWith('data:')) return true;
    const resolved = new URL(raw, window.location.href);
    if (resolved.protocol === 'blob:' || resolved.protocol === 'data:') return true;
    return resolved.origin === window.location.origin;
  } catch {
    // Unparseable — treat as unsafe. Refusing to route costs a feature;
    // routing a source that turns out to be cross-origin costs the sound.
    return false;
  }
}

type AudioContextCtor = new () => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    // Safari (including older iOS versions still in the field) only exposes
    // the prefixed constructor.
    const win = window as unknown as {
      AudioContext?: AudioContextCtor;
      webkitAudioContext?: AudioContextCtor;
    };
    return win.AudioContext ?? win.webkitAudioContext;
  } catch {
    // Reading a global should never throw in practice; guarded anyway so
    // REQUIREMENT 5 ("never breaks real playback") holds even here.
    return undefined;
  }
}

/**
 * Calls `fn`, swallowing BOTH a synchronous throw and (when `fn` returns a
 * thenable) a rejection. Every browser-facing call in this module goes
 * through this — adversarial review found the previous version wrapped only
 * promise rejections, which left a synchronous throw from a legacy/partial
 * `AudioContext` implementation (missing `resume`/`suspend`/`close`, or one
 * that throws instead of rejecting on an invalid state transition) free to
 * propagate out of `start()`/`suspend()`/`close()` and into whatever called
 * them — for `start()`, that is `playImperative`'s gesture-synchronous path,
 * mid-function, BEFORE the real `<audio>` element's own play() promise
 * handlers get registered. That is exactly the damage REQUIREMENT 5 forbids.
 */
function safeInvoke(fn: () => unknown): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Rejected (blocked, wrong state, unsupported) — best-effort only.
      });
    }
  } catch {
    // Threw synchronously instead of rejecting — same treatment.
  }
}

/**
 * Builds one keepalive handle. Construction itself does nothing observable —
 * no `AudioContext` is created until `start()` is first called — so it is
 * safe to build eagerly (e.g. in a `useRef` lazy initializer) without that
 * choice alone spinning anything up.
 */
export function createSilentKeepalive(
  options: SilentKeepaliveOptions = {},
): SilentKeepaliveHandle {
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  // A buffer source node can only ever be started once in its lifetime — a
  // second `.start()` call throws. This guards `start()` being called again
  // (e.g. on every subsequent play gesture) from trying to restart a node
  // that is already looping.
  let sourceStarted = false;
  // Elements bound into this context. A `WeakSet` because membership is the
  // only question ever asked of it, and because a bound element must never be
  // kept alive by this module's bookkeeping.
  const routedElements = new WeakSet<HTMLMediaElement>();
  // Per-element role gain nodes, for callers that routed WITH a gain (see
  // `routeElement`'s `options.gain`). Only holds the elements that asked for
  // one — an element routed at unity is absent, and `setElementGain` reports
  // that honestly rather than pretending to have silenced it.
  const elementGains = new WeakMap<HTMLMediaElement, GainNode>();
  // Whether ANY element has been bound. Separate from the WeakSet because the
  // difference between "a dead context with nothing captive" (harmless, just
  // rebuild) and "a dead context holding the only element that can make sound"
  // (an emergency) is exactly this flag.
  let anyRouted = false;
  // True once the caller has been told to escape. From then on this handle is
  // inert: it must never build a second context (the captive elements could
  // not be re-bound to it anyway — `InvalidStateError`) and must never fire
  // `onRoutingLost` twice.
  let routingLost = false;
  // Latched by `close()` once elements have been bound. Those elements are
  // captive in the closed context forever, so building a replacement would
  // create a live graph carrying nothing while every real element stays mute
  // in the dead one — undetectably, since no error or event is emitted.
  let closedForGood = false;
  // Whether the caller currently wants sound. `suspend()` puts the context in
  // a non-running state ON PURPOSE (the user paused), and a graph that is
  // silent because nobody asked for sound is not a graph that has failed.
  let wantSound = false;
  let lossTimer: number | null = null;

  const emit = (message: string, detail?: Record<string, unknown>) => {
    try {
      options.onEvent?.(message, detail);
    } catch {
      // A diagnostic sink must never be able to break playback.
    }
  };

  const clearLossTimer = () => {
    if (lossTimer !== null) {
      try {
        window.clearTimeout(lossTimer);
      } catch {
        // Non-browser environment; nothing to clear.
      }
      lossTimer = null;
    }
  };

  // Point of no return: the graph is carrying at least one element and can no
  // longer make sound. Everything here is teardown — the handle deliberately
  // does NOT try to rebuild, because a fresh context cannot take the captive
  // elements back (an element binds once per document, full stop). The caller
  // is now the only thing that can restore audio.
  const declareRoutingLost = (reason: string) => {
    if (routingLost) return;
    routingLost = true;
    clearLossTimer();
    emit('routingLost', { reason });
    try {
      options.onRoutingLost?.(reason);
    } catch {
      // Same contract as every other callback here.
    }
  };

  // Re-evaluated on every `statechange` AND once more after the grace window,
  // because neither alone is sufficient: `statechange` can deliver
  // 'interrupted' with no follow-up event ever arriving, and a timer alone
  // would miss a context that recovers and re-fails inside one window.
  const evaluateHealth = (fromStateChange = false) => {
    const current = ctx;
    if (routingLost || !current) return;
    // TWO DIFFERENT JOBS, and conflating them left the tone dead.
    //
    // Declaring routing lost only makes sense when an element is captive in
    // this context — with nothing routed there is nothing to rescue. But
    // RESUMING is worth doing either way: once routing became opt-in
    // (`graphRoutingEnabled`), `anyRouted` stays false for the whole session
    // in the default mode, and an early return here made the `statechange`
    // handler inert. A phone call or a backgrounding would interrupt the
    // context and nothing would ever bring it back — the tone would simply
    // stop, silently, for the rest of the session. Caught by adversarial
    // review, which noticed the comment claiming "the tone still runs" was an
    // assumption rather than something the code did.
    const st0 = current.state as AudioContextState | 'interrupted';
    if (!anyRouted) {
      // Only from a real transition. `start()` already resumes on its own and
      // then calls in here, so reviving unconditionally would just issue the
      // same control message twice on every play.
      if (fromStateChange && wantSound && st0 !== 'running' && st0 !== 'closed') {
        safeInvoke(() => current.resume());
      }
      return;
    }
    // 'interrupted' is Safari-only and absent from the TS union.
    const st = current.state as AudioContextState | 'interrupted';
    if (st === 'running') {
      clearLossTimer();
      return;
    }
    if (st === 'closed') {
      // Unrecoverable by definition — no grace window can help, and
      // `resume()` on a closed context rejects.
      declareRoutingLost('context-closed');
      return;
    }
    if (!wantSound) {
      // Suspended because the user paused. Expected, not a failure.
      clearLossTimer();
      return;
    }
    // Suspended or interrupted while the song is supposed to be sounding.
    // Ask for it back first — an interruption from a phone call is routinely
    // recoverable, and handing the session over to the escape element is a
    // one-way, double-buffering-ending move that should not be spent on
    // something a `resume()` fixes.
    safeInvoke(() => current.resume());
    if (lossTimer !== null) return; // already counting down for this outage
    try {
      lossTimer = window.setTimeout(() => {
        lossTimer = null;
        const c = ctx;
        if (routingLost || !anyRouted || !c || !wantSound) return;
        const now = c.state as AudioContextState | 'interrupted';
        if (now === 'running') return;
        declareRoutingLost(`context-${now}`);
      }, ROUTING_LOSS_GRACE_MS);
    } catch {
      // No timers available (non-browser test environment). `statechange`
      // remains as the other trigger.
    }
  };

  // REQUIREMENT 5 (tolerant to failure): every step that can throw or reject —
  // construction, `.start()`, `.resume()`/`.suspend()`/`.close()` — goes
  // through `safeInvoke` or its own try/catch, so a failure here can never
  // propagate into the real playback path. Worst case, this function's
  // effects are simply absent for the rest of the session and music keeps
  // playing exactly as it does today.
  function buildGraph(): boolean {
    if (routingLost || closedForGood) return false;
    if (ctx && ctx.state !== 'closed') return true;
    // A closed context with an element bound to it is NOT rebuildable: the
    // captive element cannot be re-bound to the replacement, so a second
    // context would be a graph carrying silence while the song sits mute in
    // the dead one. Escalate instead of quietly rebuilding.
    if (ctx && anyRouted) {
      declareRoutingLost('context-closed');
      return false;
    }
    // Either never built, or the browser closed the previous one out from
    // under us with nothing captive in it — reset and rebuild from scratch.
    clearLossTimer();
    ctx = null;
    source = null;
    sourceStarted = false;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return false;
    try {
      const newCtx = new Ctor();
      const gain = newCtx.createGain();
      // Exactly zero — this is the one property that makes the difference
      // between "silent keepalive" and "an audible pop or hum nobody asked
      // for". See the "gain is exactly 0" test.
      gain.gain.value = 0;
      gain.connect(newCtx.destination);
      const buffer = newCtx.createBuffer(
        1,
        Math.max(1, Math.floor(newCtx.sampleRate * SILENT_BUFFER_SECONDS)),
        newCtx.sampleRate,
      );
      const newSource = newCtx.createBufferSource();
      newSource.buffer = buffer;
      newSource.loop = true;
      newSource.connect(gain);
      // The only signal this module gets that the OS took the audio session
      // away. Attached before the context is published so no transition can
      // land in the gap. `addEventListener` where available, falling back to
      // the property form for older/partial `webkitAudioContext` shapes that
      // never implemented EventTarget on the context.
      try {
        if (typeof newCtx.addEventListener === 'function') {
          newCtx.addEventListener('statechange', () => {
            emit('contextState', { state: String(newCtx.state) });
            evaluateHealth(true);
          });
        } else {
          (newCtx as AudioContext).onstatechange = () => {
            emit('contextState', { state: String(newCtx.state) });
            evaluateHealth(true);
          };
        }
      } catch {
        // No state observation available. Routing loss then depends on the
        // grace timer armed by the next `start()`/`routeElement` — degraded,
        // not broken.
      }
      ctx = newCtx;
      source = newSource;
      sourceStarted = false;
      return true;
    } catch {
      // Construction blocked/unsupported/out of resources — leave everything
      // null so every other method below treats this as "no keepalive",
      // until the next `start()` tries again.
      ctx = null;
      source = null;
      return false;
    }
  }

  const start = () => {
    wantSound = true;
    if (!buildGraph() || !ctx || !source) return;
    if (!sourceStarted) {
      try {
        source.start(0);
        sourceStarted = true;
      } catch {
        // Already started, or the context is in a state that rejects it —
        // best-effort only.
      }
    }
    const current = ctx;
    // Unconditional — see this method's own docstring for the stale-`.state`
    // race an earlier, gated version had. `resume()` on an already-running
    // context is a defined no-op per spec, so there is no cost to calling it
    // every time `start()` runs.
    safeInvoke(() => current.resume());
    // A context that was ALREADY interrupted when `start()` ran emits no
    // `statechange` of its own — nothing changed — so without this the only
    // observer of a graph that is captive and mute would never run.
    evaluateHealth();
  };

  const suspend = () => {
    wantSound = false;
    clearLossTimer();
    if (!ctx) return;
    const current = ctx;
    safeInvoke(() => current.suspend());
  };

  const setPlaybackIntent = (wanted: boolean) => {
    wantSound = wanted;
    // Re-evaluate immediately: intent turning true on a context that is
    // ALREADY interrupted emits no `statechange` of its own (nothing changed),
    // so without this the graph could sit captive and mute with nobody
    // watching. Intent turning false clears any countdown that was running for
    // an outage nobody is listening through.
    if (!wanted) clearLossTimer();
    evaluateHealth();
  };

  const close = () => {
    wantSound = false;
    clearLossTimer();
    // Terminal for a handle that has carried elements — see `close`'s
    // docstring. Set BEFORE the early return so a second `close()`, or a
    // `close()` on a handle whose context was already torn down by the
    // browser, still latches it.
    if (anyRouted) closedForGood = true;
    if (!ctx) return;
    const toClose = ctx;
    // Dropped BEFORE the close() call, which is also what keeps our own
    // teardown from being mistaken for the browser taking the session away:
    // the resulting `statechange` finds `ctx === null` and `evaluateHealth`
    // returns without declaring anything lost.
    ctx = null;
    source = null;
    sourceStarted = false;
    safeInvoke(() => toClose.close());
  };

  const getState = (): KeepaliveContextState => ctx?.state ?? null;

  const routeElement = (el: HTMLMediaElement, options?: { gain?: number }): boolean => {
    if (!el) return false;
    if (routedElements.has(el)) return true;
    if (routingLost) return false;
    // Never build the graph from here: routing must ride on a context that a
    // real user gesture already brought up (`start()`), never spin one up on
    // its own from whatever call site happens to run first.
    const current = ctx;
    if (!current) return false;
    if (!isSameOriginSource(el)) {
      // Not a failure to report loudly — the element simply keeps playing
      // straight out of itself, which is audible and correct. Emitted so a
      // trace can explain why a session shows `routing: 'direct'`.
      emit('routeRefused', { reason: 'cross-origin-source' });
      return false;
    }
    try {
      const node = current.createMediaElementSource(el);
      // Straight to the destination, at unity — no gain node of our own, and
      // that is a MEASURED choice, not an assumption. Probed in Chrome with
      // an AnalyserNode on a routed element playing a square wave: RMS 0.722
      // at `volume = 1`, 0.0721 at `volume = 0.1`, exactly 0 at `muted =
      // true`, back to 0.722 on restore. The element's own volume/mute are
      // therefore applied UPSTREAM of this tap and still work; inserting a
      // gain node here would have double-applied the user's volume slider.
      // (Unverified on iOS, where element volume is read-only anyway.)
      // The zero-gain tone reaches the same destination through its own gain
      // node — same origin, two sources, one output.
      //
      // A caller that passes `options.gain` is mixing SEVERAL routed elements
      // into this one context and needs to choose which of them is audible;
      // it gets a gain node of its own here. Everyone else keeps the measured
      // unity connect above, unchanged.
      const roleGain = options?.gain;
      if (typeof roleGain === 'number' && Number.isFinite(roleGain)) {
        const g = current.createGain();
        g.gain.value = Math.min(Math.max(roleGain, 0), 1);
        node.connect(g);
        g.connect(current.destination);
        elementGains.set(el, g);
      } else {
        node.connect(current.destination);
      }
      routedElements.add(el);
      anyRouted = true;
      emit('routed', {});
      // A context that is already non-running at bind time is a graph that
      // just swallowed the song — check immediately rather than waiting for a
      // transition that has already happened.
      evaluateHealth();
      return true;
    } catch {
      // `InvalidStateError` (already bound elsewhere), an unsupported
      // implementation, anything: leave the element alone. Direct output is
      // the safe outcome, and this module's whole failure policy is that
      // being absent must never cost the user sound.
      emit('routeFailed', {});
      return false;
    }
  };

  const setElementGain = (el: HTMLMediaElement, value: number): boolean => {
    const g = el ? elementGains.get(el) : undefined;
    const current = ctx;
    if (!g || !current) return false;
    const target = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
    try {
      const now = current.currentTime;
      // `cancelAndHoldAtTime`, NOT `cancelScheduledValues`, and the difference
      // is the whole reason a fast next/prev/next does not click:
      // `cancelScheduledValues` removes the in-flight ramp and the parameter
      // REVERTS to the value of the last event before `now` — it does not stay
      // where the signal actually got to. Reading `.value` afterwards and
      // re-anchoring there (an earlier version of this function) therefore
      // anchors at the wrong place, which is the discontinuity it was written
      // to prevent. `cancelAndHoldAtTime` holds the parameter at its CURRENT
      // interpolated value, which is the only correct starting point.
      //
      // Safari shipped it as `cancelAndHoldAtTime`; older WebKit only ever had
      // the prefixed `cancelValuesAndHoldAtTime`. Where neither exists, fall
      // back to cancel + explicit anchor: wrong on the rare mid-ramp reversal,
      // correct in the common case where nothing was in flight.
      const param = g.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
        cancelValuesAndHoldAtTime?: (t: number) => void;
      };
      const hold = param.cancelAndHoldAtTime ?? param.cancelValuesAndHoldAtTime;
      if (typeof hold === 'function') {
        hold.call(param, now);
      } else {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
      }
      g.gain.linearRampToValueAtTime(target, now + GAIN_RAMP_SECONDS);
    } catch {
      // Partial `AudioParam` (jsdom, older webkit shapes): assign directly.
      // A click at the switch beats a gain that never moves at all.
      //
      // Cancel first, best-effort: assigning `.value` does NOT clear pending
      // automation, so if an earlier call did manage to schedule a ramp before
      // this one started throwing, that ramp would keep running and overwrite
      // the value just assigned. On a partial implementation there is usually
      // nothing to cancel and this throws too, which is fine.
      try {
        g.gain.cancelScheduledValues(0);
      } catch {
        // No automation API at all — then there is no pending ramp either.
      }
      try {
        g.gain.value = target;
      } catch {
        return false;
      }
    }
    return true;
  };

  const getRouting = (el: HTMLMediaElement | null | undefined): AudioRouting =>
    el && routedElements.has(el) ? 'graph' : 'direct';

  const isRoutingLost = () => routingLost;

  return {
    start,
    suspend,
    setPlaybackIntent,
    close,
    getState,
    routeElement,
    setElementGain,
    getRouting,
    isRoutingLost,
  };
}
