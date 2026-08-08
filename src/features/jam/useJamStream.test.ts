import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Jam, JamSnapshot } from '../../api/schemas/jam';
import { useJamStream } from './useJamStream';

// The room this hook is following can change, and until now nothing said so.
// `snapshot` and `connected` were three loose `useState`s reset only when the
// id went null, so switching straight from one room to another kept the old
// room's queue, name and `connected: true` alive for as long as the new
// stream took to send its first frame — for ever, if it never did. What the
// caller then published was one room's data under another room's destination,
// and transport went to the room being described rather than the one chosen.
//
// Every test here is about that boundary: what a room switch must erase, and
// what must survive an ordinary reconnect.

interface FakeSource {
  url: string;
  withCredentials: boolean;
  closed: boolean;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: (() => void) | null;
}

let sources: FakeSource[] = [];

/** Minimal stand-in: the hook only ever assigns `onmessage`/`onerror` and
 *  calls `close()`, and jsdom ships no EventSource at all. */
class FakeEventSource implements FakeSource {
  url: string;
  withCredentials: boolean;
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    sources.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

/** The stream currently open, i.e. the last one constructed and not closed. */
function openSource(): FakeSource {
  const live = sources.filter((source) => !source.closed);
  expect(live).toHaveLength(1);
  return live[0] as FakeSource;
}

function sourceFor(jamId: string): FakeSource {
  const match = sources.find((source) => source.url.includes(jamId));
  if (!match) throw new Error(`no EventSource was opened for ${jamId}`);
  return match;
}

function jamFixture(overrides: Partial<Jam> & { id: string }): Jam {
  return {
    name: `Sala ${overrides.id}`,
    mode: 'king',
    ownerId: 'me',
    createdAt: 0,
    members: [],
    queue: [],
    current: { index: 0, positionMs: 0, isPlaying: false, at: 0 },
    seq: 0,
    ...overrides,
  };
}

function snapshotFixture(jam: Jam): JamSnapshot {
  return { jam, present: ['me'], leaderId: 'me' };
}

/** Deliver a frame the way the server would: a JSON string on `message`. */
function emit(source: FakeSource, snapshot: JamSnapshot): void {
  act(() => {
    source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(snapshot) }));
  });
}

function fail(source: FakeSource, times = 1): void {
  act(() => {
    for (let i = 0; i < times; i += 1) source.onerror?.();
  });
}

function setup(jamId: string | null) {
  return renderHook((props: { jamId: string | null }) => useJamStream(props.jamId), {
    initialProps: { jamId },
  });
}

// jsdom's own EventSource, if this version has one, is restored afterwards so
// nothing leaks out of this file.
const realEventSource = globalThis.EventSource;

beforeEach(() => {
  sources = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.EventSource = realEventSource;
});

describe('useJamStream', () => {
  it('opens a credentialed stream for the room and publishes its frames', () => {
    const { result } = setup('jam-a');

    expect(openSource().url).toBe('/bff/jam/jam-a/stream');
    expect(openSource().withCredentials).toBe(true);
    expect(result.current).toEqual({ snapshot: null, connected: false, denied: false });

    const snapshot = snapshotFixture(jamFixture({ id: 'jam-a', name: 'Ruta a la costa' }));
    emit(openSource(), snapshot);

    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.connected).toBe(true);
  });

  it('opens no stream and stays empty with no room chosen', () => {
    const { result } = setup(null);

    expect(sources).toHaveLength(0);
    expect(result.current).toEqual({ snapshot: null, connected: false, denied: false });
  });

  it('restores a persisted destination on mount: a room id present from the first render streams normally', () => {
    // The reload case. `destination.ts` reads localStorage synchronously, so
    // the very first render already carries a room — there is no null render
    // to reset from, and the initial state has to be right without one.
    const { result } = setup('jam-persisted');

    expect(openSource().url).toBe('/bff/jam/jam-persisted/stream');
    const snapshot = snapshotFixture(jamFixture({ id: 'jam-persisted' }));
    emit(openSource(), snapshot);

    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.connected).toBe(true);
    expect(result.current.denied).toBe(false);
  });

  it('leaves nothing of room A behind when the destination becomes room B', () => {
    // THE regression. Reverting the room stamp in useJamStream — going back to
    // resetting only when the id turns null — fails on the two assertions
    // right after the rerender: `snapshot` still holds A's, `connected` is
    // still true, and a caller reading them publishes A's name, A's queue and
    // A's transport target while the destination already says B.
    const { result, rerender } = setup('jam-a');
    const roomA = snapshotFixture(jamFixture({ id: 'jam-a', name: 'Ruta a la costa', seq: 7 }));
    emit(openSource(), roomA);
    expect(result.current.connected).toBe(true);

    rerender({ jamId: 'jam-b' });

    expect(result.current.snapshot).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.denied).toBe(false);
    // A's stream is not merely ignored, it is gone: presence is the connection,
    // so a room left open would keep this user seated in a room they left.
    expect(sourceFor('jam-a').closed).toBe(true);
    expect(openSource().url).toBe('/bff/jam/jam-b/stream');

    const roomB = snapshotFixture(jamFixture({ id: 'jam-b', name: 'es', seq: 0 }));
    emit(openSource(), roomB);

    expect(result.current.snapshot).toEqual(roomB);
    expect(result.current.connected).toBe(true);
  });

  it("does not resurrect room A's state when B's stream never delivers", () => {
    // The slow, refused or offline stream — the case that made the leak
    // permanent instead of momentary. Nothing arrives for B, and the answer
    // must stay empty rather than fall back to the last room that worked.
    const { result, rerender } = setup('jam-a');
    emit(openSource(), snapshotFixture(jamFixture({ id: 'jam-a', name: 'Ruta a la costa' })));

    rerender({ jamId: 'jam-b' });
    fail(openSource(), 2);
    rerender({ jamId: 'jam-b' });

    expect(result.current.snapshot).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it("ignores a late frame from the room that was just left", () => {
    // Belt and braces: close() should stop the old source, but a frame already
    // dispatched must not overwrite the new room either.
    const { result, rerender } = setup('jam-a');
    const staleSource = openSource();
    rerender({ jamId: 'jam-b' });

    emit(staleSource, snapshotFixture(jamFixture({ id: 'jam-a', name: 'Ruta a la costa' })));

    expect(result.current.snapshot).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it('does not let a late frame from the old room overwrite the new room once it is live', () => {
    // The dangerous direction of the same race, and the one that would be
    // silent: B is already playing when A's straggler lands. Without the
    // per-stream guard the caller would be handed A's queue and A's playhead
    // under B's destination — the original bug, arriving late.
    const { result, rerender } = setup('jam-a');
    const staleSource = openSource();
    rerender({ jamId: 'jam-b' });
    const roomB = snapshotFixture(jamFixture({ id: 'jam-b', name: 'es', seq: 1 }));
    emit(openSource(), roomB);

    emit(staleSource, snapshotFixture(jamFixture({ id: 'jam-a', name: 'Ruta a la costa', seq: 99 })));

    expect(result.current.snapshot).toEqual(roomB);
    expect(result.current.connected).toBe(true);
  });

  it("does not let the old room's failures count towards refusing the new one", () => {
    // The counters were a single ref shared by every room this hook followed,
    // so two errors against A meant B was one error away from being declared
    // refused — and being declared refused now un-routes playback.
    const { result, rerender } = setup('jam-a');
    fail(openSource(), 2);

    rerender({ jamId: 'jam-b' });
    fail(openSource(), 1);

    expect(result.current.denied).toBe(false);
  });

  it("does not let the old room's sequence number blind the new one", () => {
    // Same shared-ref fault, other counter: a room that got as far as seq 99
    // would make every early frame of the next room look stale and be dropped,
    // leaving it permanently blank.
    const { result, rerender } = setup('jam-a');
    emit(openSource(), snapshotFixture(jamFixture({ id: 'jam-a', seq: 99 })));

    rerender({ jamId: 'jam-b' });
    const roomB = snapshotFixture(jamFixture({ id: 'jam-b', seq: 0 }));
    emit(openSource(), roomB);

    expect(result.current.snapshot).toEqual(roomB);
    expect(result.current.connected).toBe(true);
  });

  it('does not claim to be live again when the same room is re-chosen after going local', () => {
    // Leave the room and come straight back — the id matches what the leftover
    // state is stamped with, so a stamp alone would hand back the previous
    // visit's snapshot as if the new stream had already answered: `connected`
    // true, transport enabled, a playhead from minutes ago that the follower
    // would seek to. Only resetting on "the room turned null" (the original
    // shape of this bug) misses it too, since it never turns null between the
    // two renders that matter.
    const { result, rerender } = setup('jam-a');
    const first = snapshotFixture(jamFixture({ id: 'jam-a', seq: 4 }));
    emit(openSource(), first);
    expect(result.current.connected).toBe(true);

    rerender({ jamId: null });
    rerender({ jamId: 'jam-a' });

    expect(result.current.snapshot).toBeNull();
    expect(result.current.connected).toBe(false);

    const second = snapshotFixture(jamFixture({ id: 'jam-a', seq: 5 }));
    emit(openSource(), second);
    expect(result.current.snapshot).toEqual(second);
  });

  it('ignores an error from the stream that was just left', () => {
    const { result, rerender } = setup('jam-a');
    const staleSource = openSource();
    rerender({ jamId: 'jam-b' });
    const roomB = snapshotFixture(jamFixture({ id: 'jam-b' }));
    emit(openSource(), roomB);

    fail(staleSource, 5);

    expect(result.current.connected).toBe(true);
    expect(result.current.denied).toBe(false);
    expect(result.current.snapshot).toEqual(roomB);
  });

  it('clears the room and closes the stream when the destination goes back to null', () => {
    const { result, rerender } = setup('jam-a');
    emit(openSource(), snapshotFixture(jamFixture({ id: 'jam-a' })));
    const source = openSource();

    rerender({ jamId: null });

    expect(source.closed).toBe(true);
    expect(result.current).toEqual({ snapshot: null, connected: false, denied: false });
  });

  it('marks the room as dropped but keeps its last state when a live stream errors', () => {
    // A tunnel, not a refusal: the frame we have is the best guess at the room
    // and stays on screen, flagged stale by `connected`.
    const { result } = setup('jam-a');
    const snapshot = snapshotFixture(jamFixture({ id: 'jam-a' }));
    emit(openSource(), snapshot);

    fail(openSource(), 5);

    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.connected).toBe(false);
    // Never opened is what "denied" means; this one opened.
    expect(result.current.denied).toBe(false);
    expect(openSource().closed).toBe(false);
  });

  it('gives up as denied after three failures without a single frame', () => {
    const { result } = setup('jam-a');
    const source = openSource();

    fail(source, 2);
    expect(result.current.denied).toBe(false);

    fail(source, 1);

    expect(result.current.denied).toBe(true);
    expect(result.current.connected).toBe(false);
    expect(result.current.snapshot).toBeNull();
    // Stopped trying, or EventSource would keep retrying against the refusal.
    expect(source.closed).toBe(true);
  });

  it('does not carry a denial into the next room', () => {
    const { result, rerender } = setup('jam-a');
    fail(openSource(), 3);
    expect(result.current.denied).toBe(true);

    rerender({ jamId: 'jam-b' });

    expect(result.current.denied).toBe(false);
    const roomB = snapshotFixture(jamFixture({ id: 'jam-b' }));
    emit(openSource(), roomB);
    expect(result.current.snapshot).toEqual(roomB);
  });

  it('drops a frame older than the one already shown', () => {
    const { result } = setup('jam-a');
    const newer = snapshotFixture(jamFixture({ id: 'jam-a', name: 'Nueva', seq: 5 }));
    emit(openSource(), newer);

    emit(openSource(), snapshotFixture(jamFixture({ id: 'jam-a', name: 'Vieja', seq: 2 })));

    expect(result.current.snapshot).toEqual(newer);
  });

  it('ignores a malformed frame instead of tearing the room down', () => {
    const { result } = setup('jam-a');
    const snapshot = snapshotFixture(jamFixture({ id: 'jam-a' }));
    emit(openSource(), snapshot);

    act(() => {
      openSource().onmessage?.(new MessageEvent('message', { data: '{"jam":{"nope":true}}' }));
    });

    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.connected).toBe(true);
  });
});
