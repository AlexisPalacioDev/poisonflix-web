import { describe, expect, it } from 'vitest';
import { musicPlayerReducer as reducer, musicPlayerInitialState as initial, naturalOrder, shuffleOrder, type MusicPlayerState, type MusicTrack } from './musicPlayerCore';

// Slice 2 queue-model unit tests. The reducer is pure (randomness enters only
// via the `order` payload the provider computes), so every transition —
// playNow, next, prev, ended+repeat, shuffle, enqueue, jump, remove — is
// asserted deterministically here.

const track = (id: string): MusicTrack => ({ itemId: id, title: id, artist: null, coverUrl: null });
const tracks = [track('a'), track('b'), track('c')];

/** Queue index of the current track (mirrors the provider's derivation). */
function currentIndex(s: MusicPlayerState): number {
  return s.pos >= 0 ? s.order[s.pos] : -1;
}

function playFrom(index: number): MusicPlayerState {
  return reducer(initial, { type: 'PLAY_QUEUE', tracks, index, order: naturalOrder(3) });
}

describe('musicPlayerReducer — playNow / PLAY_QUEUE', () => {
  it('replaces the queue and starts at the given index', () => {
    const s = playFrom(1);
    expect(s.queue).toEqual(tracks);
    expect(currentIndex(s)).toBe(1);
    expect(s.isPlaying).toBe(true);
    expect(s.position).toBe(0);
  });

  it('clamps an out-of-range start index', () => {
    expect(currentIndex(playFrom(99))).toBe(2);
    expect(currentIndex(playFrom(-5))).toBe(0);
  });

  it('ignores an empty track list', () => {
    const s = reducer(initial, { type: 'PLAY_QUEUE', tracks: [], index: 0, order: [] });
    expect(s).toBe(initial);
  });
});

describe('musicPlayerReducer — next', () => {
  it('advances to the following track', () => {
    const s = reducer(playFrom(0), { type: 'NEXT' });
    expect(currentIndex(s)).toBe(1);
    expect(s.isPlaying).toBe(true);
  });

  it('stops at the end of the queue when repeat is off', () => {
    let s = reducer(playFrom(2), { type: 'NEXT' });
    expect(currentIndex(s)).toBe(2); // last track stays shown
    expect(s.isPlaying).toBe(false);
  });

  it('wraps to the start when repeat is all', () => {
    let s = reducer(playFrom(2), { type: 'SET_REPEAT', mode: 'all' });
    s = reducer(s, { type: 'NEXT' });
    expect(currentIndex(s)).toBe(0);
    expect(s.isPlaying).toBe(true);
  });
});

describe('musicPlayerReducer — prev', () => {
  it('restarts the current track when past the threshold', () => {
    let s = reducer(playFrom(1), { type: 'SET_POSITION', position: 10 });
    const nonce = s.seekNonce;
    s = reducer(s, { type: 'PREV' });
    expect(currentIndex(s)).toBe(1); // same track
    expect(s.position).toBe(0);
    expect(s.seekNonce).toBe(nonce + 1);
  });

  it('goes to the previous track when near the start', () => {
    let s = reducer(playFrom(1), { type: 'SET_POSITION', position: 1 });
    s = reducer(s, { type: 'PREV' });
    expect(currentIndex(s)).toBe(0);
  });

  it('restarts the first track instead of going out of bounds', () => {
    const s = reducer(playFrom(0), { type: 'PREV' });
    expect(currentIndex(s)).toBe(0);
    expect(s.position).toBe(0);
  });
});

describe('musicPlayerReducer — ended (auto NEXT) + repeat', () => {
  it('re-plays the same track when repeat is one', () => {
    let s = reducer(playFrom(1), { type: 'SET_REPEAT', mode: 'one' });
    s = reducer(s, { type: 'SET_POSITION', position: 30 });
    const nonce = s.seekNonce;
    s = reducer(s, { type: 'NEXT', auto: true });
    expect(currentIndex(s)).toBe(1); // unchanged
    expect(s.position).toBe(0);
    expect(s.isPlaying).toBe(true);
    expect(s.seekNonce).toBe(nonce + 1);
  });

  it('still advances on a manual next even with repeat one', () => {
    let s = reducer(playFrom(1), { type: 'SET_REPEAT', mode: 'one' });
    s = reducer(s, { type: 'NEXT' });
    expect(currentIndex(s)).toBe(2);
  });
});

describe('musicPlayerReducer — shuffle', () => {
  it('produces a permutation with the current track pinned first', () => {
    const order = shuffleOrder(5, 3, () => 0); // deterministic rng
    expect(order[0]).toBe(3);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the current track current after toggling shuffle on', () => {
    const playing = playFrom(1); // current queue index 1
    const s = reducer(playing, { type: 'SET_SHUFFLE', value: true, order: [1, 2, 0] });
    expect(s.shuffle).toBe(true);
    expect(currentIndex(s)).toBe(1); // same track, new play order
    expect(s.pos).toBe(0);
  });

  it('advances through the shuffled order, not the display order', () => {
    let s = reducer(playFrom(0), { type: 'SET_SHUFFLE', value: true, order: [0, 2, 1] });
    s = reducer(s, { type: 'NEXT' });
    expect(currentIndex(s)).toBe(2);
  });
});

describe('musicPlayerReducer — enqueue', () => {
  it('starts playback when the queue was empty', () => {
    const s = reducer(initial, { type: 'ENQUEUE', tracks });
    expect(s.queue).toEqual(tracks);
    expect(currentIndex(s)).toBe(0);
    expect(s.isPlaying).toBe(true);
  });

  it('appends without disturbing the current track', () => {
    let s = playFrom(1);
    s = reducer(s, { type: 'ENQUEUE', tracks: [track('d')] });
    expect(s.queue.map((t) => t.itemId)).toEqual(['a', 'b', 'c', 'd']);
    expect(currentIndex(s)).toBe(1);
    expect(s.order).toEqual([0, 1, 2, 3]);
  });
});

describe('musicPlayerReducer — jumpTo / remove', () => {
  it('jumps to a queue index', () => {
    const s = reducer(playFrom(0), { type: 'JUMP_TO', index: 2 });
    expect(currentIndex(s)).toBe(2);
    expect(s.isPlaying).toBe(true);
  });

  it('removes a track before the current one and keeps it current', () => {
    let s = playFrom(1); // current 'b'
    s = reducer(s, { type: 'REMOVE', index: 0 }); // drop 'a'
    expect(s.queue.map((t) => t.itemId)).toEqual(['b', 'c']);
    expect(s.queue[currentIndex(s)].itemId).toBe('b');
  });

  it('clears playback when the last track is removed', () => {
    let s = reducer(initial, { type: 'PLAY_QUEUE', tracks: [track('a')], index: 0, order: [0] });
    s = reducer(s, { type: 'REMOVE', index: 0 });
    expect(s.queue).toEqual([]);
    expect(s.pos).toBe(-1);
    expect(s.isPlaying).toBe(false);
  });
});

describe('shuffleOrder / naturalOrder helpers', () => {
  it('naturalOrder is the identity sequence', () => {
    expect(naturalOrder(4)).toEqual([0, 1, 2, 3]);
  });

  it('shuffleOrder with an out-of-range first still returns a full permutation', () => {
    const order = shuffleOrder(3, -1, () => 0);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe('SET_DURATION', () => {
  const loaded = reducer(initial, {
    type: 'PLAY_QUEUE',
    tracks: [{ itemId: 'a', title: 'A', artist: null, coverUrl: null, durationSeconds: 216 }],
    index: 0,
    order: [0],
  });

  it('takes a real length from the audio element', () => {
    const next = reducer(loaded, { type: 'SET_DURATION', duration: 210 });
    expect(next.duration).toBe(210);
  });

  it('ignores the 0 the element reports before metadata lands', () => {
    const seeded = reducer(loaded, { type: 'SET_DURATION', duration: 216 });
    const next = reducer(seeded, { type: 'SET_DURATION', duration: 0 });
    // Dropping back to 0 would leave the progress bar with no scale, which
    // renders as permanently finished.
    expect(next.duration).toBe(216);
  });

  it('ignores Infinity from a stream whose length is unknown', () => {
    const seeded = reducer(loaded, { type: 'SET_DURATION', duration: 216 });
    const next = reducer(seeded, { type: 'SET_DURATION', duration: Infinity });
    expect(next.duration).toBe(216);
  });

  it('ignores NaN', () => {
    const next = reducer(loaded, { type: 'SET_DURATION', duration: NaN });
    expect(next.duration).toBe(0);
  });
});
