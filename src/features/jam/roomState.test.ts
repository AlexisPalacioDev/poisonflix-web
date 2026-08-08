import { afterEach, describe, expect, it } from 'vitest';
import type { JamTrack } from '../../api/schemas/jam';
import { jamRoom, setJamRoom, type JamRoomState } from './roomState';

// The store the NowPlayingBar reads to become the room's control.
//
// The property worth asserting hard is that an unchanged room keeps the SAME
// object. `JamPlaybackHost` republishes on every SSE frame and on every render
// of its parent, and each frame is parsed into brand-new objects, so a store
// that stored whatever it was handed would change identity several times a
// second. `useSyncExternalStore` compares exactly that identity to decide
// whether to re-render — and warns (then loops) when `getSnapshot` keeps
// returning something new. Identity here IS the notification, which is why
// these tests assert on it rather than on a spy.

function track(overrides: Partial<JamTrack> = {}): JamTrack {
  return {
    itemId: 'track-1',
    title: 'Track',
    artist: null,
    coverUrl: null,
    addedBy: 'someone',
    ...overrides,
  };
}

function roomFixture(overrides: Partial<JamRoomState> = {}): JamRoomState {
  return {
    jamId: 'jam-1',
    name: 'Ruta a la costa',
    track: track(),
    index: 0,
    queue: [track()],
    playhead: { index: 0, positionMs: 0, isPlaying: true, at: 1_000 },
    canControl: true,
    connected: true,
    ...overrides,
  };
}

afterEach(() => setJamRoom(null));

describe('roomState', () => {
  it('keeps the published room stable across an identical republish', () => {
    const first = roomFixture();
    setJamRoom(first);
    expect(jamRoom()).toBe(first);

    // What every repeated SSE frame looks like: same content, new objects.
    setJamRoom(roomFixture());
    expect(jamRoom()).toBe(first);
  });

  it('swaps identity when the playhead moves', () => {
    setJamRoom(roomFixture());
    const before = jamRoom();

    setJamRoom(roomFixture({ playhead: { index: 0, positionMs: 0, isPlaying: false, at: 1_000 } }));

    expect(jamRoom()).not.toBe(before);
    expect(jamRoom()?.playhead.isPlaying).toBe(false);
  });

  it('swaps identity for a new track, new rights, a dropped stream or a changed queue', () => {
    const variants: Array<Partial<JamRoomState>> = [
      { track: track({ itemId: 'track-2', title: 'Otra' }) },
      { canControl: false },
      { connected: false },
      { queue: [track(), track({ itemId: 'track-2' })] },
      { name: 'Otro nombre' },
      { index: 1 },
    ];

    for (const variant of variants) {
      setJamRoom(roomFixture());
      const before = jamRoom();
      setJamRoom(roomFixture(variant));
      expect(jamRoom(), `unchanged for ${JSON.stringify(variant)}`).not.toBe(before);
    }
  });

  it('clears back to null', () => {
    setJamRoom(roomFixture());
    setJamRoom(null);
    expect(jamRoom()).toBeNull();
  });
});
