// Keeping a device in step with the room's playhead.
//
// Pure on purpose: this is the arithmetic that decides whether two helmets
// hear the same bar, and it is far easier to get right — and to prove right —
// away from an <audio> element and a network.
//
// The correction is deliberately gentle. A hard seek is audible as a cut, and
// on a motorcycle the riders are talking to each other over the intercom, so a
// click in the music is more disruptive than being a quarter-second apart.
// Nothing here is trying to hit sample accuracy: nobody is hearing both
// streams in the same air, so the tolerance is human, not acoustic.

// The playhead's shape comes from the wire contract, not a second interface
// declared here. `tsconfig.app.json` does not enable `strict`, so zod infers
// every field as optional under `npm run build` — and a hand-written twin with
// required fields only fails to line up there, never under `tsc --noEmit`.
export type { JamPlayhead as PlayheadTarget } from '../../api/schemas/jam';
import type { JamPlayhead as PlayheadTarget } from '../../api/schemas/jam';

export type PlayheadAction =
  /** Already close enough, or paused and in the right place. */
  | { kind: 'hold' }
  | { kind: 'pause' }
  /** Start playing from here — this device was silent and should not be. */
  | { kind: 'play'; positionMs: number }
  /** Too far off to nudge; jump. */
  | { kind: 'seek'; positionMs: number }
  /** Close: converge by playing slightly fast or slow instead of jumping. */
  | { kind: 'rate'; rate: number };

/** Below this, leave it alone. Chasing the last tenth of a second would mean
 *  never settling, and nobody can hear it. */
const DEAD_ZONE_MS = 150;

/** Above this, something discontinuous happened — a seek, a track change, a
 *  long stall in a tunnel — and creeping back would take minutes. Jump. */
const HARD_SEEK_MS = 1200;

/** How long a nudge is allowed to take to close the gap. Slower is less
 *  audible; faster recovers sooner. */
const CORRECTION_WINDOW_MS = 15_000;

/** Ceiling on the speed change. Beyond a few percent the pitch shift starts to
 *  be noticeable, which defeats the point of nudging instead of seeking. */
const MAX_RATE_DEVIATION = 0.04;

/** Where the room should be right now, given when its playhead was set.
 *  `serverNow` is this device's clock corrected by the measured offset — never
 *  its raw `Date.now()`, which can be minutes out on a phone. */
export function expectedPositionMs(target: PlayheadTarget, serverNow: number): number {
  if (!target.isPlaying) return target.positionMs;
  return target.positionMs + Math.max(0, serverNow - target.at);
}

export function followPlayhead(input: {
  target: PlayheadTarget;
  serverNow: number;
  localPositionMs: number;
  localPlaying: boolean;
}): PlayheadAction {
  const { target, serverNow, localPositionMs, localPlaying } = input;
  const expected = expectedPositionMs(target, serverNow);

  if (!target.isPlaying) {
    if (localPlaying) return { kind: 'pause' };
    // A paused room still has a position: someone may have scrubbed while it
    // was stopped, and this device has to land there before anyone presses
    // play again.
    if (Math.abs(localPositionMs - expected) > HARD_SEEK_MS) {
      return { kind: 'seek', positionMs: expected };
    }
    return { kind: 'hold' };
  }

  if (!localPlaying) return { kind: 'play', positionMs: expected };

  // Positive drift means this device is ahead of the room.
  const drift = localPositionMs - expected;
  if (Math.abs(drift) > HARD_SEEK_MS) return { kind: 'seek', positionMs: expected };
  if (Math.abs(drift) <= DEAD_ZONE_MS) return { kind: 'rate', rate: 1 };

  const correction = Math.max(
    -MAX_RATE_DEVIATION,
    Math.min(MAX_RATE_DEVIATION, drift / CORRECTION_WINDOW_MS),
  );
  // Ahead → play slower; behind → play faster.
  return { kind: 'rate', rate: Number((1 - correction).toFixed(4)) };
}

/** Should this device be making sound at all?
 *
 * The two modes differ only here, which is why one follower drives both. In
 * `king` only the acting leader's device sounds and everyone else is a remote
 * control; in `everyone` every attached member plays. */
export function shouldSound(
  mode: 'king' | 'everyone',
  ownUserId: string | null,
  leaderId: string | null,
  present: ReadonlySet<string>,
): boolean {
  if (!ownUserId) return false;
  if (mode === 'king') return leaderId === ownUserId;
  return present.has(ownUserId);
}
