import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { measureJamClockOffset, sendJamTransport } from '../../api/jam';
import type { Jam, JamSnapshot, JamTrack } from '../../api/schemas/jam';
import { useOptionalMusicPlayer, type MusicPlayerContextValue } from '../music/musicPlayerCore';
import { setJamDestination } from './destination';
import { useJamPlayback } from './useJamPlayback';

// Regression coverage for the bug the owner just fixed: leaving a Jam (or
// switching output to "Solo yo") must silence the room's own <audio> element
// immediately. The old code checked `!snapshot` before `!active`, and leaving
// a room clears `snapshot` in the very same cycle that clears `active` — so
// the early return fired before `audio.pause()` ever ran, and the Jam kept
// sounding on top of whatever played next. See the ordering comment in
// useJamPlayback.ts for the full story.

vi.mock('../../api/jam', () => ({
  measureJamClockOffset: vi.fn().mockResolvedValue(0),
  sendJamTransport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../music/musicPlayerCore', () => ({
  useOptionalMusicPlayer: vi.fn(),
}));

const mockedUseOptionalMusicPlayer = vi.mocked(useOptionalMusicPlayer);
const mockedMeasureJamClockOffset = vi.mocked(measureJamClockOffset);
const mockedSendJamTransport = vi.mocked(sendJamTransport);

type PlayMock = MockInstance<(...args: never[]) => Promise<void>>;
type VoidMock = MockInstance<(...args: never[]) => void>;

let playSpy: PlayMock;
let pauseSpy: VoidMock;
let loadSpy: VoidMock;

const OWN_ID = 'me';

function trackFixture(overrides: Partial<JamTrack> = {}): JamTrack {
  return {
    itemId: 'track-1',
    title: 'Track',
    artist: null,
    coverUrl: null,
    addedBy: 'someone',
    // A streamUrl sidesteps trackSrc()'s Jellyfin-session branch, which is
    // irrelevant to what this file is testing.
    streamUrl: 'https://stream.example/track-1.mp3',
    ...overrides,
  };
}

function jamFixture(overrides: Partial<Jam> = {}): Jam {
  return {
    id: 'jam-1',
    name: 'Jam',
    mode: 'king',
    ownerId: OWN_ID,
    createdAt: 0,
    members: [],
    queue: [trackFixture()],
    current: { index: 0, positionMs: 0, isPlaying: true, at: Date.now() },
    seq: 0,
    ...overrides,
  };
}

function snapshotFixture(overrides: {
  jam?: Partial<Jam>;
  present?: string[];
  leaderId?: string | null;
}): JamSnapshot {
  return {
    jam: jamFixture(overrides.jam),
    present: overrides.present ?? [OWN_ID],
    leaderId: overrides.leaderId ?? OWN_ID,
  };
}

/** Only the two fields useJamPlayback reads (`isPlaying`, `toggle`) matter
 *  here — the rest of the real context is irrelevant to this hook. */
function fakePlayer(overrides: Partial<Pick<MusicPlayerContextValue, 'isPlaying' | 'toggle'>> = {}) {
  return {
    isPlaying: false,
    toggle: vi.fn(),
    ...overrides,
  } as unknown as MusicPlayerContextValue;
}

function setup(initial: { snapshot: JamSnapshot | null; ownUserId: string | null }) {
  const audioRef: { current: HTMLAudioElement | null } = { current: document.createElement('audio') };
  const view = renderHook(
    (props: { snapshot: JamSnapshot | null; ownUserId: string | null }) =>
      useJamPlayback(props.snapshot, props.ownUserId, audioRef),
    { initialProps: initial },
  );
  return { ...view, audioRef };
}

beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined) as PlayMock;
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}) as VoidMock;
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}) as VoidMock;
  mockedUseOptionalMusicPlayer.mockReturnValue(fakePlayer());
  mockedMeasureJamClockOffset.mockClear();
  mockedSendJamTransport.mockClear();
});

afterEach(() => {
  // Unmount BEFORE restoring the spies: useJamPlayback's own unmount effect
  // pauses the element, and jsdom's real (unmocked) `pause()` just logs "not
  // implemented" — harmless, but noisy in the test output.
  cleanup();
  vi.restoreAllMocks();
  // `destination.ts` is module-scope + localStorage, so a value chosen in one
  // test would otherwise leak into the next.
  setJamDestination(null);
  window.localStorage.clear();
});

describe('useJamPlayback', () => {
  it('loads and plays the room track when routed to the Jam and this device is meant to sound', () => {
    act(() => setJamDestination('jam-1'));
    const snapshot = snapshotFixture({ leaderId: OWN_ID });

    const { result, audioRef } = setup({ snapshot, ownUserId: OWN_ID });

    expect(result.current.active).toBe(true);
    expect(audioRef.current?.src).toBe('https://stream.example/track-1.mp3');
    expect(loadSpy).toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalled();
  });

  it('pauses the Jam audio the instant the snapshot disappears, in the same render `active` turns false', () => {
    // This is the exact shape of the original bug, reproduced with a single
    // prop change so the render is deterministic: `active` is derived from
    // `snapshot` (`active = routedToJam && snapshot ? ... : false`), so the
    // moment a room's snapshot clears, `active` clears in that SAME render —
    // there is no separate render where one goes stale before the other. A
    // `!snapshot` guard placed before the `!active` guard (the reverted
    // order) returns from the effect before `audio.pause()` ever runs, which
    // is precisely what let two tracks sound at once. Combining this with an
    // explicit `setJamDestination(null)` in the same act is NOT equivalent:
    // that store update is delivered through a separate `useSyncExternalStore`
    // notification, which lands as its own extra render before this one and
    // pauses on its own — masking a reverted guard order instead of catching it.
    act(() => setJamDestination('jam-1'));
    const snapshot = snapshotFixture({ leaderId: OWN_ID });
    const { result, rerender, audioRef } = setup({ snapshot, ownUserId: OWN_ID });
    expect(result.current.active).toBe(true);
    playSpy.mockClear();

    rerender({ snapshot: null, ownUserId: OWN_ID });

    expect(result.current.active).toBe(false);
    expect(pauseSpy).toHaveBeenCalled();
    // Nothing should have restarted playback after the room let go.
    expect(playSpy).not.toHaveBeenCalled();
    expect(audioRef.current?.paused).toBe(true);
  });

  it('pauses the Jam audio the instant the destination clears, before the snapshot prop catches up', () => {
    act(() => setJamDestination('jam-1'));
    const snapshot = snapshotFixture({ leaderId: OWN_ID });
    const { result } = setup({ snapshot, ownUserId: OWN_ID });
    expect(result.current.active).toBe(true);
    playSpy.mockClear();

    // Only the destination changes here — the `snapshot` prop is still the
    // room's, exactly like the render in between "Solo yo" being tapped and
    // the parent re-deriving its own state from that change.
    act(() => setJamDestination(null));

    expect(result.current.active).toBe(false);
    expect(pauseSpy).toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('silences the local player once routed to a Jam even when this device is not the one meant to sound', () => {
    // King mode, present but not the leader: `active` is false (this device
    // is a remote), yet the local player still has to yield the speaker to
    // the chosen output.
    act(() => setJamDestination('jam-1'));
    const toggle = vi.fn();
    mockedUseOptionalMusicPlayer.mockReturnValue(fakePlayer({ isPlaying: true, toggle }));
    const snapshot = snapshotFixture({ leaderId: 'someone-else', present: [OWN_ID, 'someone-else'] });

    const { result } = setup({ snapshot, ownUserId: OWN_ID });

    expect(result.current.active).toBe(false);
    expect(toggle).toHaveBeenCalled();
  });

  it('leaves the local player alone when routed to no Jam ("Solo yo")', () => {
    const toggle = vi.fn();
    mockedUseOptionalMusicPlayer.mockReturnValue(fakePlayer({ isPlaying: true, toggle }));
    const snapshot = snapshotFixture({ leaderId: OWN_ID });

    setup({ snapshot, ownUserId: OWN_ID });

    expect(toggle).not.toHaveBeenCalled();
  });
});
