// Accelerating seek: the step grows while you keep seeking and snaps back once
// you stop. A fixed 10s step is fine for skipping a scene and useless for
// crossing an hour — that is 360 presses — so both ends need covering.
//
// Pure, with the timestamp passed in, so every timing boundary is unit-tested
// without a fake clock. Mirrors `SeekAccelerator.kt` on the projector: the two
// players should feel the same in the hand.

/** 5s, 10s, 30s, 1min, 2min, 5min. Starts BELOW the old fixed 10s so a single
 * tap is finer than before — a wider range at both ends, not just a coarser one. */
export const SEEK_LADDER_SECONDS = [5, 10, 30, 60, 120, 300];

/** Presses per rung before climbing; roughly half a second of key auto-repeat. */
export const PRESSES_PER_RUNG = 3;

/** Idle gap that ends a run: longer than the repeat interval, shorter than a pause to look. */
export const RESET_AFTER_MS = 900;

export interface SeekRun {
  presses: number;
  lastPressAtMs: number;
}

export function newSeekRun(): SeekRun {
  return { presses: 0, lastPressAtMs: Number.NEGATIVE_INFINITY };
}

/**
 * The step for a press at [nowMs], plus the run to carry into the next one.
 *
 * Returns a new run rather than mutating so this can live in a ref or in state
 * without the caller worrying about when it changed.
 */
export function nextSeekStep(run: SeekRun, nowMs: number): { seconds: number; run: SeekRun } {
  const idle = nowMs - run.lastPressAtMs;
  // A gap means the user let go and is aiming again; without the reset a
  // careful press minutes later would still jump five minutes.
  const presses = idle > RESET_AFTER_MS ? 0 : run.presses;
  const rung = Math.min(Math.floor(presses / PRESSES_PER_RUNG), SEEK_LADDER_SECONDS.length - 1);
  return {
    seconds: SEEK_LADDER_SECONDS[rung],
    run: { presses: presses + 1, lastPressAtMs: nowMs },
  };
}

/** "30s" / "2min" — the step, in the coarsest unit that stays exact. */
export function formatSeekStep(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}min`;
}
