// Client-side failure log.
//
// Music reporting, autoplay radio and download polling are all deliberately
// best-effort: a failed call must never break playback. That is the right call,
// but it was implemented as `.catch(() => {})`, which makes the failure
// invisible — and a feature that fails silently is indistinguishable from one
// that has nothing to show. The personalised feed sat empty for weeks for
// exactly this reason: the listen reports were failing and nothing said so.
//
// So best-effort keeps meaning "never throws", but now it also means "always
// leaves a trace". Failures land in the console and in a bounded ring buffer
// reachable from devtools as `window.__pfErrors`, so a report can be pulled off
// a live session without a rebuild.

export type ClientFailure = {
  at: string;
  scope: string;
  message: string;
  detail?: unknown;
};

// Bounded so a retry loop cannot grow it without limit.
const MAX = 100;
const buffer: ClientFailure[] = [];

declare global {
  interface Window {
    __pfErrors?: ClientFailure[];
  }
}

/**
 * Record a swallowed failure. Never throws — callers rely on that.
 *
 * `scope` is a stable dot-path (`music.scrobble.preview`) rather than free text,
 * so occurrences can be counted per call site.
 */
export function reportFailure(scope: string, cause: unknown, detail?: unknown): void {
  try {
    const message =
      cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? 'unknown');
    const entry: ClientFailure = { at: new Date().toISOString(), scope, message, detail };

    buffer.push(entry);
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
    if (typeof window !== 'undefined') window.__pfErrors = buffer;

    // eslint-disable-next-line no-console -- this IS the observability channel
    console.warn(`[poisonflix] ${scope}: ${message}`, detail ?? '');

    // Also ship it to the server. `window.__pfErrors` is unreachable in practice
    // on a phone, and the defect that matters most right now only reproduces on
    // one — so the payload has to land somewhere readable without a debugger.
    // keepalive so a report during teardown still leaves; failures are ignored,
    // because a diagnostic that breaks the app is worse than no diagnostic.
    if (typeof fetch === 'function') {
      void fetch('/bff/client-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, message, detail }),
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Reporting a failure must never itself become one.
  }
}

/** Snapshot of recorded failures, newest last. */
export function recordedFailures(): readonly ClientFailure[] {
  return buffer.slice();
}

/** Test helper — the buffer is module state that would otherwise leak between tests. */
export function clearRecordedFailures(): void {
  buffer.length = 0;
  if (typeof window !== 'undefined') window.__pfErrors = buffer;
}
