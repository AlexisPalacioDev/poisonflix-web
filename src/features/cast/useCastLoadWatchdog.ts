import { useCallback, useEffect, useState } from 'react';

// The watchdog that keeps `/cast/:id` from becoming a permanently mute screen.
//
// ## Why a watchdog and not a per-fetch timeout
// The obvious fix is an `AbortSignal` with a deadline on each request. It was
// rejected because it only covers the failure it imagines. This screen can sit
// on "Cargando…" for reasons that are not a hanging `fetch` at all: a query
// that stays disabled because an upstream answer arrived empty, a promise that
// resolves into a state with no next step, a render that simply never gets its
// data. Every one of those looks identical from three metres away, and every
// one of them needs the same exit.
//
// So the deadline is on the WAIT, not on the request. Whatever the screen is
// waiting for, if it is still waiting when the clock runs out, the television
// says so and offers a way out. That is a strictly wider net than aborting a
// socket, and it is the net this codebase's scars call for: the defect is
// never the failure itself, it is the silence around it.
//
// ## Why the phase is a string
// This project compiles WITHOUT `strictNullChecks`, where TypeScript cannot
// narrow a union by a boolean literal - the same reason `CastScreen`'s
// `SurfaceState` and `castUrls.ts`'s `CastUrlsResult` are string unions.

/**
 * What the screen is currently waiting on.
 *
 * `'ready'` means it is waiting on nothing: it is playing, or it already has a
 * message on it. The watchdog holds no timer in that phase.
 */
export type CastLoadPhase = 'viewer' | 'stream' | 'ready';

export type CastWatchdogState = 'waiting' | 'expired';

/**
 * How long a phase may stay silent before the television speaks up.
 *
 * ## The trade, stated honestly
 * A television on a weak 2.4GHz link is LEGITIMATELY slow. Too short a budget
 * turns a bad-but-working connection into a false error, and a false error on
 * this screen is expensive: whoever is standing there has no console to check,
 * so a wrong diagnosis sends them to go restart a router that was fine.
 *
 * ## Why twenty seconds
 * Both waits are small JSON round trips over the LAN. `GET /Users/Me` is a
 * row lookup. `POST .../PlaybackInfo` is the slow one - the server probes the
 * media and decides direct-play vs transcode - and on a cold spinning disk
 * that is single-digit seconds, not tens. Twenty is therefore roughly an order
 * of magnitude past a slow-but-HEALTHY answer: well beyond any WiFi
 * retransmit, DHCP renewal, or the server waking a disk, and not plausibly
 * reachable by a request that is actually going to arrive.
 *
 * ## Why not longer, and why the asymmetry decides it
 * The two errors do not cost the same. A false timeout costs one press of a
 * button that is already focused, and the retry re-issues the request that was
 * merely slow - the loss is seconds. A timeout that never fires costs the
 * evening: the screen never changes, nothing explains it, and the only exit is
 * finding the TV's browser UI with a remote. When one error is recoverable in
 * one click and the other is not recoverable at all, the budget belongs on the
 * generous side of "slow" and nowhere near the far side of "gave up" - which
 * for a person watching an unchanging screen arrives around half a minute.
 *
 * Per PHASE, not for the whole screen: a viewer lookup that took nineteen
 * seconds must not eat the stream resolution's budget, or a merely slow
 * network would be reported as a broken one.
 *
 * ## What this number is NOT
 * It is reasoned, not measured. Unlike `usePlaybackInfo`'s header, which cites
 * a live observation against the server, nobody has timed these two calls from
 * the television on a weak link. The reasoning above is what makes twenty
 * defensible without that; a measurement is what would let anyone move it. So
 * if this ever fires on a connection that was merely slow, the fix is to time
 * the two requests on the real TV and set this from the tail of what comes
 * back - not to double it because a timeout was annoying once.
 */
export const CAST_LOAD_TIMEOUT_MS = 20_000;

export interface CastLoadWatchdog {
  state: CastWatchdogState;
  /** Re-arms the timer for the current phase. Call it when retrying, so the
   *  retry gets the full budget instead of firing again immediately. */
  restart: () => void;
}

export function useCastLoadWatchdog(phase: CastLoadPhase, timeoutMs = CAST_LOAD_TIMEOUT_MS): CastLoadWatchdog {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CastWatchdogState>('waiting');

  useEffect(() => {
    // Re-armed on every phase change AND on every retry, so each wait is
    // measured from when THAT wait started.
    setState('waiting');
    // Nothing is being waited for: no timer, and `'waiting'` is the honest
    // answer. `CastScreen` renders the same either way (its expired branch
    // sits behind an earlier return), so this line is defence in depth - which
    // is exactly the kind of line that gets deleted during a tidy-up. It is
    // pinned in `useCastLoadWatchdog.test.ts` for that reason.
    if (phase === 'ready') return undefined;

    const timer = setTimeout(() => setState('expired'), timeoutMs);
    return () => clearTimeout(timer);
  }, [phase, timeoutMs, attempt]);

  const restart = useCallback(() => setAttempt((previous) => previous + 1), []);

  return { state, restart };
}
