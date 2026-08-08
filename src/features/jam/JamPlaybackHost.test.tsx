import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { listJams } from '../../api/jam';
import type { Jam, JamListEntry, JamMember, JamSnapshot } from '../../api/schemas/jam';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { jamDestination, setJamDestination } from './destination';
import { JamPlaybackHost } from './JamPlaybackHost';
import { jamRoom, setJamRoom } from './roomState';

// The producer nobody was testing.
//
// Everything downstream — the bar's name, its transport target, its queue
// drawer — reads `roomState`, and this component is the only thing that writes
// it. The bar's own tests inject that state by hand, so they prove the bar
// paints correct data correctly; nothing proved the data was correct. Two
// faults lived in exactly that gap:
//
//  1. switching rooms kept publishing the OLD room under the NEW destination,
//     so play/pause went to a room the user had just left;
//  2. the destination was cleared during render, which React answers with a
//     warning and, under concurrent rendering, a dropped update.
//
// Both are asserted here against the real `useJamStream`, driven by a fake
// EventSource, because a mocked stream would have hidden the first one.

vi.mock('../../api/jam', () => ({
  listJams: vi.fn(),
  sendJamTransport: vi.fn().mockResolvedValue(undefined),
  measureJamClockOffset: vi.fn().mockResolvedValue(0),
}));

// The real store, with every publish recorded: asserting on the last value
// only would let a wrong intermediate publish slip through, and a wrong
// intermediate publish is precisely what the room-switch bug was.
vi.mock('./roomState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./roomState')>();
  return { ...actual, setJamRoom: vi.fn(actual.setJamRoom) };
});

const mockedListJams = vi.mocked(listJams);
const mockedSetJamRoom = vi.mocked(setJamRoom);

const OWN_ID = 'jellyseerr-me';
const ROOM_A = 'e641079d-bcea-4161-9b05-f48ccb9ca1e2';
const ROOM_B = '2cf6fbd6-0077-4e69-8e1e-20b0a4e12068';

interface FakeSource {
  url: string;
  closed: boolean;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: (() => void) | null;
}

let sources: FakeSource[] = [];

class FakeEventSource implements FakeSource {
  url: string;
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sources.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function streamFor(jamId: string): FakeSource {
  const match = sources.find((source) => source.url.includes(jamId) && !source.closed);
  if (!match) throw new Error(`no open EventSource for ${jamId}`);
  return match;
}

function member(userId: string): JamMember {
  return { userId, name: userId, role: 'controller', invitedAt: 0, acceptedAt: 0 };
}

function jamFixture(overrides: Partial<Jam> & { id: string }): Jam {
  return {
    name: `Sala ${overrides.id}`,
    mode: 'king',
    ownerId: OWN_ID,
    createdAt: 0,
    members: [member(OWN_ID)],
    queue: [],
    current: { index: 0, positionMs: 0, isPlaying: false, at: 0 },
    seq: 0,
    ...overrides,
  };
}

function listEntry(jam: Jam): JamListEntry {
  return { jam, present: [], leaderId: null, myRole: member(OWN_ID) };
}

function snapshotFixture(jam: Jam): JamSnapshot {
  return { jam, present: [OWN_ID], leaderId: OWN_ID };
}

function emit(jamId: string, snapshot: JamSnapshot): void {
  act(() => {
    streamFor(jamId).onmessage?.(new MessageEvent('message', { data: JSON.stringify(snapshot) }));
  });
}

const jamA = jamFixture({ id: ROOM_A, name: 'Ruta a la costa' });
const jamB = jamFixture({ id: ROOM_B, name: 'es', seq: 3 });

function renderHost({ signedIn = true }: { signedIn?: boolean } = {}) {
  if (signedIn) {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'jellyfin-guid', jellyseerrCookiePresent: true });
  } else {
    clearSession();
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <JamPlaybackHost />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Every room published since the last `mockClear`, oldest first. */
function publishedJamIds(): Array<string | null> {
  return mockedSetJamRoom.mock.calls.map(([room]) => room?.jamId ?? null);
}

const realEventSource = globalThis.EventSource;
let consoleError: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  sources = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  // jsdom implements none of these and logs "not implemented" for each; the
  // follower calls them as soon as a room is live.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) as MockInstance<
    (...args: unknown[]) => void
  >;
  mockedListJams.mockResolvedValue([listEntry(jamA), listEntry(jamB)]);
  mockedSetJamRoom.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.EventSource = realEventSource;
  clearSession();
  setJamDestination(null);
  window.localStorage.clear();
});

/** React reports a render-phase update to another component through
 *  `console.error`. Nothing in this component may provoke it. */
function expectNoRenderPhaseUpdate(): void {
  const offending = consoleError.mock.calls.filter((args) =>
    args.some((arg) => typeof arg === 'string' && arg.includes('while rendering a different component')),
  );
  expect(offending).toEqual([]);
}

describe('JamPlaybackHost', () => {
  it('publishes the room it is streaming, live, once the first frame lands', async () => {
    // Also the reload case: the destination is already set when the component
    // mounts, exactly as `destination.ts` restores it from localStorage.
    setJamDestination(ROOM_A);
    renderHost();

    // The list entry stands in until the stream speaks — the right room, named,
    // and flagged as not yet live.
    await waitFor(() => expect(jamRoom()?.jamId).toBe(ROOM_A));
    expect(jamRoom()?.name).toBe('Ruta a la costa');
    expect(jamRoom()?.connected).toBe(false);
    expect(jamRoom()?.canControl).toBe(false);

    emit(ROOM_A, snapshotFixture(jamFixture({ id: ROOM_A, name: 'Ruta a la costa', seq: 9 })));

    expect(jamRoom()?.connected).toBe(true);
    expect(jamRoom()?.canControl).toBe(true);
    expectNoRenderPhaseUpdate();
  });

  it('publishes nothing of the old room once the destination moves to another one', async () => {
    // THE regression, at the level that matters: what the rest of the app is
    // told. Revert the room stamp in `useJamStream` and this fails on the very
    // next assertion — `roomState` keeps carrying room A's id, name and
    // `connected: true` while the destination already says B, which is how
    // pressing play paused a room the user had left.
    setJamDestination(ROOM_A);
    renderHost();
    await waitFor(() => expect(jamRoom()?.jamId).toBe(ROOM_A));
    emit(ROOM_A, snapshotFixture(jamFixture({ id: ROOM_A, name: 'Ruta a la costa', seq: 9 })));
    expect(jamRoom()?.connected).toBe(true);
    mockedSetJamRoom.mockClear();

    // No rerender() alongside this: `useSyncExternalStore` schedules its own,
    // and pairing the two inside one act() lets the extra render mask a
    // reverted fix.
    act(() => setJamDestination(ROOM_B));

    expect(publishedJamIds()).not.toContain(ROOM_A);
    expect(jamRoom()?.jamId).toBe(ROOM_B);
    expect(jamRoom()?.name).toBe('es');
    expect(jamRoom()?.connected).toBe(false);
    expect(jamRoom()?.canControl).toBe(false);
    // Nothing of A's playback either: its stream is closed, so its seat is
    // given up rather than held by a component still listening to it.
    expect(sources.find((source) => source.url.includes(ROOM_A))?.closed).toBe(true);

    emit(ROOM_B, snapshotFixture(jamFixture({ id: ROOM_B, name: 'es', seq: 4 })));

    expect(jamRoom()?.jamId).toBe(ROOM_B);
    expect(jamRoom()?.connected).toBe(true);
    expect(publishedJamIds()).not.toContain(ROOM_A);
    expectNoRenderPhaseUpdate();
  });

  it("keeps publishing nothing of the old room while the new room's stream stays silent", async () => {
    // The permanent version of the same fault: B never answers (slow, refused,
    // no network), so there is no first frame to overwrite the leftover with.
    setJamDestination(ROOM_A);
    renderHost();
    await waitFor(() => expect(jamRoom()?.jamId).toBe(ROOM_A));
    emit(ROOM_A, snapshotFixture(jamFixture({ id: ROOM_A, seq: 9 })));

    act(() => setJamDestination(ROOM_B));
    act(() => {
      streamFor(ROOM_B).onerror?.();
      streamFor(ROOM_B).onerror?.();
    });

    expect(jamRoom()?.jamId).toBe(ROOM_B);
    expect(jamRoom()?.connected).toBe(false);
    expect(jamDestination()).toBe(ROOM_B);
  });

  it('does not claim live control of a room chosen again after going local', async () => {
    // Card → "Solo yo" → same card, three taps in a row. The destination ends
    // where it started, so anything keyed only on the id being different would
    // hand the previous visit's snapshot straight back: the bar would show
    // `canControl` and send transport into a room whose new stream has not
    // answered yet, off a playhead the follower would then seek to.
    setJamDestination(ROOM_A);
    renderHost();
    await waitFor(() => expect(jamRoom()?.jamId).toBe(ROOM_A));
    emit(ROOM_A, snapshotFixture(jamFixture({ id: ROOM_A, name: 'Ruta a la costa', seq: 9 })));
    expect(jamRoom()?.canControl).toBe(true);

    act(() => setJamDestination(null));
    act(() => setJamDestination(ROOM_A));

    expect(jamRoom()?.jamId).toBe(ROOM_A);
    expect(jamRoom()?.connected).toBe(false);
    expect(jamRoom()?.canControl).toBe(false);

    emit(ROOM_A, snapshotFixture(jamFixture({ id: ROOM_A, name: 'Ruta a la costa', seq: 10 })));
    expect(jamRoom()?.connected).toBe(true);
  });

  it('keeps the chosen output when the stream fails but so does everything else', async () => {
    // Offline at cold start looks exactly like being refused — three failures,
    // no frame — and a refusal now un-routes playback. The list failing too is
    // what tells them apart: nothing is concluded from a stream that could not
    // reach a server the rest of the app cannot reach either, so the output
    // survives the tunnel instead of being silently forgotten.
    mockedListJams.mockRejectedValue(new Error('offline'));
    setJamDestination(ROOM_A);
    renderHost();
    await waitFor(() => expect(mockedListJams).toHaveBeenCalled());

    act(() => {
      const source = streamFor(ROOM_A);
      source.onerror?.();
      source.onerror?.();
      source.onerror?.();
    });

    expect(jamDestination()).toBe(ROOM_A);
  });

  it('clears the room state when the destination goes back to this device', async () => {
    setJamDestination(ROOM_A);
    renderHost();
    await waitFor(() => expect(jamRoom()?.jamId).toBe(ROOM_A));
    emit(ROOM_A, snapshotFixture(jamFixture({ id: ROOM_A, seq: 9 })));

    act(() => setJamDestination(null));

    expect(jamRoom()).toBeNull();
    expect(sources.every((source) => source.closed)).toBe(true);
  });

  it('gives up the destination when the room refuses the stream', async () => {
    // Being removed from a room is what makes its stream refuse to open. The
    // list query has no refetch interval, so before this the only rescue was a
    // refetch that might never come, and the music stayed routed into a room
    // the user had been thrown out of.
    setJamDestination(ROOM_A);
    renderHost();
    await waitFor(() => expect(jamRoom()?.jamId).toBe(ROOM_A));

    act(() => {
      const source = streamFor(ROOM_A);
      source.onerror?.();
      source.onerror?.();
      source.onerror?.();
    });

    await waitFor(() => expect(jamDestination()).toBeNull());
    expect(jamRoom()).toBeNull();
    expectNoRenderPhaseUpdate();
  });

  it('gives up a destination that is no longer one of my rooms, without updating during render', async () => {
    // The exact reproduction from the bug report: a stale id in localStorage,
    // pointing at a room the list does not contain. It recovered even before
    // the fix — by calling `setJamDestination` in the render body, which
    // notifies `useSyncExternalStore` synchronously and made React log
    // "Cannot update a component while rendering a different component".
    // Reinstate that line and this test fails on `expectNoRenderPhaseUpdate`.
    setJamDestination('00000000-0000-4000-8000-000000000000');
    renderHost();

    await waitFor(() => expect(jamDestination()).toBeNull());
    expect(jamRoom()).toBeNull();
    expectNoRenderPhaseUpdate();
  });

  it('opens no stream and keeps the chosen output while signed out', async () => {
    // Every hook here runs above the `!session` bail-out, so a signed-out tab
    // used to open the stream anyway, collect three 401s and — now that a
    // refusal un-routes playback — throw away an output chosen while signed
    // in, which would then be gone on the next login.
    setJamDestination(ROOM_A);
    renderHost({ signedIn: false });

    await waitFor(() => expect(jamRoom()).toBeNull());
    expect(sources).toHaveLength(0);
    expect(mockedListJams).not.toHaveBeenCalled();
    expect(jamDestination()).toBe(ROOM_A);
  });

  it('keeps a destination that is still mine while the list is still loading', async () => {
    // The list resolving is what licenses the "not mine any more" verdict.
    // Dropping the destination before it arrives would un-route playback on
    // every single page load.
    let resolveList: (entries: JamListEntry[]) => void = () => {};
    mockedListJams.mockReturnValue(
      new Promise<JamListEntry[]>((resolve) => {
        resolveList = resolve;
      }),
    );
    setJamDestination(ROOM_A);
    renderHost();

    expect(jamDestination()).toBe(ROOM_A);

    await act(async () => {
      resolveList([listEntry(jamA), listEntry(jamB)]);
    });

    expect(jamDestination()).toBe(ROOM_A);
  });
});
