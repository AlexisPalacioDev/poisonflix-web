import { describe, expect, it } from 'vitest';
import {
  durationMismatch,
  musicPlayerInitialState as initial,
  musicPlayerReducer as reducer,
  shouldForceAdvance,
  visibleBuffering,
  type MusicPlayerState,
} from './musicPlayerCore';

// Reliability-change reducer/pure-function units. `SYNC_MEDIA` is the single
// action every real <audio> event (play/playing/pause/waiting/stalled/canplay)
// dispatches through — see MusicPlayerProvider.media.test.tsx for the DOM
// wiring. This file keeps that wiring's decisions pure and testable without
// mounting React at all.

describe('reducer — SYNC_MEDIA', () => {
  it('a playing patch sets isPlaying, leaving buffering untouched', () => {
    const s = reducer(initial, { type: 'SYNC_MEDIA', playing: true });
    expect(s.isPlaying).toBe(true);
    expect(s.buffering).toBe(false);
  });

  it('a buffering patch sets buffering without touching isPlaying', () => {
    const playing: MusicPlayerState = { ...initial, isPlaying: true };
    const s = reducer(playing, { type: 'SYNC_MEDIA', buffering: true });
    expect(s.buffering).toBe(true);
    expect(s.isPlaying).toBe(true); // untouched by the buffering-only patch
  });

  it('a combined patch sets both fields in one dispatch', () => {
    const s = reducer(initial, { type: 'SYNC_MEDIA', playing: true, buffering: false });
    expect(s.isPlaying).toBe(true);
    expect(s.buffering).toBe(false);
  });

  it('returns the SAME state reference when the patch is a no-op (identity-return)', () => {
    const base: MusicPlayerState = { ...initial, isPlaying: true, buffering: false };
    const s = reducer(base, { type: 'SYNC_MEDIA', playing: true, buffering: false });
    expect(s).toBe(base); // toBe, not toEqual — must be the exact same object
  });

  it('an empty patch (all fields omitted) is also a no-op', () => {
    const base: MusicPlayerState = { ...initial, isPlaying: true, buffering: true };
    const s = reducer(base, { type: 'SYNC_MEDIA' });
    expect(s).toBe(base);
  });
});

describe('visibleBuffering — buffering exposed only while actually playing', () => {
  it('is false when isPlaying is false, even if the raw buffering field is true', () => {
    const s: MusicPlayerState = { ...initial, isPlaying: false, buffering: true };
    expect(visibleBuffering(s)).toBe(false);
  });

  it('is true when both isPlaying and buffering are true', () => {
    const s: MusicPlayerState = { ...initial, isPlaying: true, buffering: true };
    expect(visibleBuffering(s)).toBe(true);
  });

  it('is false when buffering is false regardless of isPlaying', () => {
    const s: MusicPlayerState = { ...initial, isPlaying: true, buffering: false };
    expect(visibleBuffering(s)).toBe(false);
  });
});

describe('durationMismatch', () => {
  it('reports the unidentified 2x-duration defect shape as a mismatch', () => {
    // 386s shown vs 193.18s ffprobe-measured (design.md's own repro numbers).
    expect(durationMismatch(386, 193.18)).toBe(true);
  });

  it('does not report within the 5% band on a long track', () => {
    // known=200 -> tolerance = max(2, 10) = 10; diff = 5.
    expect(durationMismatch(200, 195)).toBe(false);
  });

  it('reports just past the 5% band on a long track', () => {
    // known=200 -> tolerance = 10; diff = 11.
    expect(durationMismatch(211, 200)).toBe(true);
  });

  it('does not report exactly at the tolerance boundary', () => {
    // known=200 -> tolerance = 10; diff = 10 (boundary, not "beyond").
    expect(durationMismatch(210, 200)).toBe(false);
  });

  it('applies the 2s floor for short tracks instead of the 5% band', () => {
    // known=10 -> tolerance = max(2, 0.5) = 2.
    expect(durationMismatch(11.5, 10)).toBe(false); // diff 1.5, within the floor
    expect(durationMismatch(12.5, 10)).toBe(true); // diff 2.5, past the floor
  });

  it('is false when the element duration is non-finite, zero, or negative', () => {
    expect(durationMismatch(Infinity, 200)).toBe(false);
    expect(durationMismatch(NaN, 200)).toBe(false);
    expect(durationMismatch(0, 200)).toBe(false);
    expect(durationMismatch(-5, 200)).toBe(false);
  });

  it('is false when the known track duration is missing, non-finite, zero, or negative', () => {
    expect(durationMismatch(200, undefined)).toBe(false);
    expect(durationMismatch(200, null)).toBe(false);
    expect(durationMismatch(200, Infinity)).toBe(false);
    expect(durationMismatch(200, 0)).toBe(false);
    expect(durationMismatch(200, -1)).toBe(false);
  });
});

describe('shouldForceAdvance — timeupdate-based advance guard (Task 1)', () => {
  // The iOS fMP4 duplicated-duration defect: the element believes the track is
  // ~2x its real length, so `ended` never arrives until the phantom end. Once
  // there IS a real duration disagreement (reused from `durationMismatch`, not
  // duplicated), reaching the KNOWN real length is exactly the signal that
  // `ended` won't come in time and playback must be forced forward.
  it('fires once a real duration mismatch exists and playback reached the known real length', () => {
    expect(shouldForceAdvance(386, 193.18, 193.18)).toBe(true); // exactly at the known length
    expect(shouldForceAdvance(400, 200, 250)).toBe(true); // past it
  });

  it('does not fire before playback reaches the known length, even with a real mismatch', () => {
    expect(shouldForceAdvance(400, 200, 100)).toBe(false);
  });

  // A healthy file never trips this, regardless of position: `durationMismatch`
  // is false whenever the element and the known length agree within tolerance,
  // so a sane track keeps relying on `ended` exactly as it does today.
  it('never fires on a healthy track, even long after its known duration', () => {
    expect(shouldForceAdvance(200, 193.18, 5000)).toBe(false); // within tolerance, huge overrun
    expect(shouldForceAdvance(202, 200, 205)).toBe(false);
  });

  // The regression this guard could most easily cause: metadata that simply
  // undershoots. `durationMismatch` is a symmetric 5%/2s band, so a track
  // advertised at 3:00 that really runs 3:40 trips it — and without a ratio
  // floor the guard would cut those 40 seconds off, every single play. Only a
  // disagreement shaped like the doubling defect may override `ended`.
  it('never truncates a track whose metadata merely undershoots the real length', () => {
    expect(shouldForceAdvance(220, 180, 180)).toBe(false); // 1.22x — bad metadata, not the defect
    expect(shouldForceAdvance(220, 180, 219)).toBe(false); // still playing real audio
    expect(shouldForceAdvance(268, 180, 180)).toBe(false); // 1.49x — just under the floor
  });

  it('still fires for a disagreement shaped like the doubling defect', () => {
    expect(shouldForceAdvance(270, 180, 180)).toBe(true); // 1.5x — at the floor
    expect(shouldForceAdvance(360, 180, 180)).toBe(true); // the real 2x defect
  });

  it('never fires when the track has no reliable known duration (falls back to `ended`)', () => {
    expect(shouldForceAdvance(400, undefined, 1000)).toBe(false);
    expect(shouldForceAdvance(400, null, 1000)).toBe(false);
    expect(shouldForceAdvance(400, 0, 1000)).toBe(false);
    expect(shouldForceAdvance(400, -1, 1000)).toBe(false);
    expect(shouldForceAdvance(400, Infinity, 1000)).toBe(false);
  });

  it('never fires when the element duration itself is non-finite, zero, or negative', () => {
    expect(shouldForceAdvance(Infinity, 200, 1000)).toBe(false);
    expect(shouldForceAdvance(NaN, 200, 1000)).toBe(false);
    expect(shouldForceAdvance(0, 200, 1000)).toBe(false);
    expect(shouldForceAdvance(-5, 200, 1000)).toBe(false);
  });
});
