import { describe, expect, it } from 'vitest';
import { expectedPositionMs, followPlayhead, shouldSound } from './jamPlayhead';

// The motorcycle case is what these numbers are tuned for: two riders, two
// helmets, two phones on mobile data, each hearing only their own intercom.
// Nobody hears both streams in the same air, so the target is "we are talking
// about the same part of the song", not sample alignment — and a click in the
// audio is worse than a quarter-second of drift.

const playing = { index: 0, positionMs: 10_000, isPlaying: true, at: 1_000_000 };

describe('expectedPositionMs', () => {
  it('projects a playing room forward from when its playhead was set', () => {
    expect(expectedPositionMs(playing, 1_003_000)).toBe(13_000);
  });

  it('leaves a paused room exactly where it was left', () => {
    expect(expectedPositionMs({ ...playing, isPlaying: false }, 1_099_000)).toBe(10_000);
  });

  it('never runs the clock backwards', () => {
    // A device whose measured offset is slightly stale can compute a
    // `serverNow` behind `at`. Subtracting it would rewind the song.
    expect(expectedPositionMs(playing, 999_000)).toBe(10_000);
  });
});

describe('followPlayhead', () => {
  it('starts playing when the room is playing and this device is silent', () => {
    const action = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 0,
      localPlaying: false,
    });
    expect(action).toEqual({ kind: 'play', positionMs: 15_000 });
  });

  it('stops when the room stops', () => {
    const action = followPlayhead({
      target: { ...playing, isPlaying: false },
      serverNow: 1_005_000,
      localPositionMs: 10_000,
      localPlaying: true,
    });
    expect(action).toEqual({ kind: 'pause' });
  });

  it('leaves a small drift alone rather than chasing it forever', () => {
    // 100ms out. Correcting this would mean never settling, and no listener
    // can hear it.
    const action = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 15_100,
      localPlaying: true,
    });
    expect(action).toEqual({ kind: 'rate', rate: 1 });
  });

  it('plays slightly slow when this device has run ahead', () => {
    const action = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 15_600, // 600ms ahead
      localPlaying: true,
    });
    expect(action.kind).toBe('rate');
    if (action.kind !== 'rate') throw new Error('expected a rate correction');
    expect(action.rate).toBeLessThan(1);
    // Audible pitch shift is the thing being avoided; a few percent is not.
    expect(action.rate).toBeGreaterThan(0.95);
  });

  it('plays slightly fast when this device has fallen behind', () => {
    const action = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 14_400, // 600ms behind
      localPlaying: true,
    });
    expect(action.kind).toBe('rate');
    if (action.kind !== 'rate') throw new Error('expected a rate correction');
    expect(action.rate).toBeGreaterThan(1);
    expect(action.rate).toBeLessThan(1.05);
  });

  it('never asks for a speed change big enough to hear as a pitch shift', () => {
    const action = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 16_100, // 1.1s ahead — still under the seek threshold
      localPlaying: true,
    });
    expect(action.kind).toBe('rate');
    if (action.kind !== 'rate') throw new Error('expected a rate correction');
    // Bounded on BOTH sides and on the right side of 1. Asserting only a floor
    // let an implementation that sped up while already ahead — the exact
    // runaway this is meant to prevent — pass the suite.
    expect(action.rate).toBeGreaterThanOrEqual(0.96);
    expect(action.rate).toBeLessThan(1);
  });

  it('holds at exactly the dead-zone edge and corrects just past it', () => {
    // Pinning the threshold itself. Every other case here sits comfortably to
    // one side, so an off-by-one — `<` where `<=` belongs — moved the dead
    // zone without failing anything.
    const at = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 15_150, // exactly 150ms ahead
      localPlaying: true,
    });
    expect(at).toEqual({ kind: 'rate', rate: 1 });

    const past = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 15_151,
      localPlaying: true,
    });
    expect(past.kind).toBe('rate');
    if (past.kind !== 'rate') throw new Error('expected a rate correction');
    expect(past.rate).toBeLessThan(1);
  });

  it('nudges at exactly the seek threshold and jumps only beyond it', () => {
    const at = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 16_200, // exactly 1200ms ahead
      localPlaying: true,
    });
    expect(at.kind).toBe('rate');

    const past = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 16_201,
      localPlaying: true,
    });
    expect(past).toEqual({ kind: 'seek', positionMs: 15_000 });
  });

  it('jumps instead of creeping when the gap is too big to close', () => {
    // A tunnel, a stall, someone scrubbing. Nudging back from here would take
    // minutes of playing off-speed.
    const action = followPlayhead({
      target: playing,
      serverNow: 1_005_000,
      localPositionMs: 3_000,
      localPlaying: true,
    });
    expect(action).toEqual({ kind: 'seek', positionMs: 15_000 });
  });

  it('lands a stopped device on the position the room was paused at', () => {
    const action = followPlayhead({
      target: { ...playing, isPlaying: false },
      serverNow: 1_090_000,
      localPositionMs: 60_000,
      localPlaying: false,
    });
    expect(action).toEqual({ kind: 'seek', positionMs: 10_000 });
  });

  it('does nothing to a stopped device already in the right place', () => {
    const action = followPlayhead({
      target: { ...playing, isPlaying: false },
      serverNow: 1_090_000,
      localPositionMs: 10_050,
      localPlaying: false,
    });
    expect(action).toEqual({ kind: 'hold' });
  });
});

describe('shouldSound', () => {
  const present = new Set(['king', 'ears']);

  it('sounds on every attached device in "everyone" mode', () => {
    // The motorcycle: both helmets play.
    expect(shouldSound('everyone', 'ears', 'king', present)).toBe(true);
  });

  it('sounds only on the leader’s device in "king" mode', () => {
    // The party: one phone is the speaker, the rest are remotes.
    expect(shouldSound('king', 'ears', 'king', present)).toBe(false);
    expect(shouldSound('king', 'king', 'king', present)).toBe(true);
  });

  it('stays silent on a device that is not in the room', () => {
    expect(shouldSound('everyone', 'ghost', 'king', present)).toBe(false);
  });

  it('stays silent before this device knows who it is', () => {
    // `ownUserId` arrives with the jams list; until then, failing closed is
    // the difference between silence and a phone that starts blaring on its
    // own.
    expect(shouldSound('everyone', null, 'king', present)).toBe(false);
  });
});
