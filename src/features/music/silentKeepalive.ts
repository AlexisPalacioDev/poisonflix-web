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

export type KeepaliveContextState = AudioContextState | null;

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
  /** Tears the context down for good. Call on provider unmount only. */
  close(): void;
  /**
   * Current `AudioContext` state, or `null` when no Web Audio support exists
   * or graph construction failed. Feeds `useLockDiagnostics` so a stalled
   * trace can say whether the keepalive was actually running at the time —
   * without this, the exact question a real hang will raise ("was the
   * keepalive even alive when it died?") has no answer.
   */
  getState(): KeepaliveContextState;
}

// One second of silence is enough to loop forever — a longer buffer buys
// nothing (it is silent either way) and only costs more memory up front.
const SILENT_BUFFER_SECONDS = 1;

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
export function createSilentKeepalive(): SilentKeepaliveHandle {
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  // A buffer source node can only ever be started once in its lifetime — a
  // second `.start()` call throws. This guards `start()` being called again
  // (e.g. on every subsequent play gesture) from trying to restart a node
  // that is already looping.
  let sourceStarted = false;

  // REQUIREMENT 5 (tolerant to failure): every step that can throw or reject —
  // construction, `.start()`, `.resume()`/`.suspend()`/`.close()` — goes
  // through `safeInvoke` or its own try/catch, so a failure here can never
  // propagate into the real playback path. Worst case, this function's
  // effects are simply absent for the rest of the session and music keeps
  // playing exactly as it does today.
  function buildGraph(): boolean {
    if (ctx && ctx.state !== 'closed') return true;
    // Either never built, or the browser closed the previous one out from
    // under us (observed on Safari as 'interrupted' degrading to 'closed', or
    // an OS-level audio session teardown) — reset and rebuild from scratch.
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
  };

  const suspend = () => {
    if (!ctx) return;
    const current = ctx;
    safeInvoke(() => current.suspend());
  };

  const close = () => {
    if (!ctx) return;
    const toClose = ctx;
    ctx = null;
    source = null;
    sourceStarted = false;
    safeInvoke(() => toClose.close());
  };

  const getState = (): KeepaliveContextState => ctx?.state ?? null;

  return { start, suspend, close, getState };
}
