import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession } from '../../lib/session/store';
import { getCurrentUser, getItem, getPlaybackInfo } from '../../api/jellyfin';
import { ApiError } from '../../lib/http/errors';
import { CAST_LOAD_TIMEOUT_MS } from './useCastLoadWatchdog';

// The last live path to a MUTE television, closed.
//
// A request that fails answers fast and gets a sentence (CastScreen.test.tsx
// covers those). A request that never answers at all - the TV drops off the
// WiFi mid-handshake, the server stops responding without closing the socket -
// used to leave `/cast/:id` on "Cargando…" for the rest of the evening. There
// is no console in front of a television and no reload button a remote can
// find, so that screen was unrecoverable in practice.
//
// Every test here is written on the REAL route tree with fake timers and
// promises that NEVER settle - which is the actual failure, and the only shape
// a rejected-promise stub cannot reproduce.

vi.mock('../../api/jellyfin', async () => {
  const actual = await vi.importActual<typeof import('../../api/jellyfin')>('../../api/jellyfin');
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getPlaybackInfo: vi.fn(),
    getItem: vi.fn(),
  };
});

const mockedGetCurrentUser = vi.mocked(getCurrentUser);
const mockedGetPlaybackInfo = vi.mocked(getPlaybackInfo);
const mockedGetItem = vi.mocked(getItem);

const URL_TOKEN = 'tv-token';
const ENTRY = `/cast/jf-item-1?token=${URL_TOKEN}`;

/** A promise that never settles - a socket that is open and silent, not a
 *  request that failed. `mockReturnValue` rather than `mockResolvedValue`
 *  precisely because there is nothing to resolve with. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const VIEWER = { Id: 'user-1', Name: 'alexis' };

function stubPlayableItem(itemId = 'jf-item-1') {
  mockedGetPlaybackInfo.mockResolvedValue({
    MediaSources: [
      {
        Id: 'ms-1',
        Container: 'mp4',
        TranscodingUrl: null,
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: false,
        MediaStreams: [],
      },
    ],
    PlaySessionId: 'sess-1',
  } as never);
  mockedGetItem.mockResolvedValue({
    Id: itemId,
    Name: 'Night of the Living Dead',
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
  } as never);
}

function renderCastScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function TestRouteTree() {
    return useRoutes(routes);
  }
  render(
    <MemoryRouter initialEntries={[ENTRY]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Advances the fake clock inside `act`, so the state the timer sets is
 *  flushed before the next assertion reads the DOM. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * Lets an already-resolved API stub reach the screen.
 *
 * `await Promise.resolve()` is NOT enough: react-query's notify manager
 * batches its subscriber notifications through `setTimeout(cb, 0)`, which a
 * fake clock holds forever. So this nudges the clock as well - by a
 * millisecond, small enough to be irrelevant to a twenty-second budget.
 */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe('/cast/:id when the server never answers at all', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    clearSession();
    onlineManager.setOnline(true);
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('replaces the endless spinner with a message that says what to do', async () => {
    mockedGetCurrentUser.mockReturnValue(neverSettles());

    renderCastScreen();
    expect(screen.getByText('Cargando…')).toBeInTheDocument();

    await advance(CAST_LOAD_TIMEOUT_MS);

    const alert = screen.getByRole('alert');
    // What happened, and the two things worth checking from the couch.
    expect(alert).toHaveTextContent(/no respondió a tiempo/i);
    expect(alert).toHaveTextContent(/conectada a la red/i);
    expect(alert).toHaveTextContent(/servidor esté encendido/i);
    expect(screen.queryByText('Cargando…')).not.toBeInTheDocument();
  });

  it('waits the full budget before saying so - a slow TV is not a broken one', async () => {
    mockedGetCurrentUser.mockReturnValue(neverSettles());

    renderCastScreen();
    await advance(CAST_LOAD_TIMEOUT_MS - 1);

    expect(screen.getByText('Cargando…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a retry a remote can actually reach and press', async () => {
    mockedGetCurrentUser.mockReturnValue(neverSettles());

    renderCastScreen();
    await advance(CAST_LOAD_TIMEOUT_MS);

    const retry = screen.getByRole('button', { name: 'Reintentar' });
    // A native <button>: `lib/tv/spatialNavigation.ts` finds D-pad candidates
    // with a selector list of real focusable elements, so a clickable <div>
    // here would be unreachable by both the remote and the Tab key.
    expect(retry.tagName).toBe('BUTTON');
    // Focused on mount: the navigator only adopts a candidate once an ARROW is
    // pressed, and a remote's OK key does not move focus. Unfocused, the first
    // press of OK would do nothing - a mute screen one keypress deeper.
    expect(document.activeElement).toBe(retry);
  });

  it('retries for real: the button re-issues the request and the video plays', async () => {
    const secondAttempt = deferred<{ Id: string; Name: string }>();
    mockedGetCurrentUser
      .mockReturnValueOnce(neverSettles())
      .mockReturnValueOnce(secondAttempt.promise as never);
    stubPlayableItem();

    renderCastScreen();
    await advance(CAST_LOAD_TIMEOUT_MS);
    expect(mockedGetCurrentUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    });
    await flush();

    // Not just "the handler ran": the request went out a second time...
    expect(mockedGetCurrentUser).toHaveBeenCalledTimes(2);
    // ...the screen went back to waiting instead of staying on the error...
    expect(screen.getByText('Cargando…')).toBeInTheDocument();

    secondAttempt.resolve(VIEWER);
    await flush();
    await flush();

    // ...and the retry actually recovered the evening.
    expect(screen.getByTestId('pf-video')).toBeInTheDocument();
  });

  it('gives the retry its own full budget instead of firing again at once', async () => {
    mockedGetCurrentUser.mockReturnValue(neverSettles());

    renderCastScreen();
    await advance(CAST_LOAD_TIMEOUT_MS);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    });

    await advance(CAST_LOAD_TIMEOUT_MS - 1);
    expect(screen.getByText('Cargando…')).toBeInTheDocument();

    await advance(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/no respondió a tiempo/i);
  });

  // The viewer lookup is only the first wait. The stream resolution
  // (PlaybackInfo + the item) is a separate request that can hang on its own,
  // and it is the SLOWER of the two - the server probes the media there.
  it('times out the stream resolution too, not only the viewer lookup', async () => {
    mockedGetCurrentUser.mockResolvedValue(VIEWER);
    mockedGetPlaybackInfo.mockReturnValue(neverSettles());
    mockedGetItem.mockReturnValue(neverSettles());

    renderCastScreen();
    await flush();
    await flush();
    expect(screen.getByText('Cargando…')).toBeInTheDocument();

    await advance(CAST_LOAD_TIMEOUT_MS);

    expect(screen.getByRole('alert')).toHaveTextContent(/no respondió a tiempo/i);

    // And the button retries THIS wait, not only the first one: the retry
    // restarts the whole load, so the request that hung goes out again.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    });
    await flush();
    await flush();

    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2);
  });

  // Otherwise a merely slow network reads as a broken one: a viewer lookup
  // that took nineteen seconds would leave the stream one second to resolve.
  it('measures each wait from when THAT wait started', async () => {
    const viewer = deferred<{ Id: string; Name: string }>();
    mockedGetCurrentUser.mockReturnValue(viewer.promise as never);
    mockedGetPlaybackInfo.mockReturnValue(neverSettles());
    mockedGetItem.mockReturnValue(neverSettles());

    renderCastScreen();
    // Almost the whole budget spent on the viewer lookup...
    await advance(CAST_LOAD_TIMEOUT_MS - 1000);
    viewer.resolve(VIEWER);
    await flush();
    await flush();

    // ...and the clock starts over for the stream: this is the instant a
    // single screen-wide deadline would have fired.
    await advance(1000);
    expect(screen.getByText('Cargando…')).toBeInTheDocument();

    await advance(CAST_LOAD_TIMEOUT_MS - 1000);
    expect(screen.getByRole('alert')).toHaveTextContent(/no respondió a tiempo/i);
  });

  // The case that decided WHERE the deadline goes. react-query's default
  // `networkMode: 'online'` PAUSES a query while the browser reports itself
  // offline - a television waking from standby before its WiFi stack
  // reattaches, or a webOS build that mis-reports `navigator.onLine`. The
  // query function is never called, so no per-request timeout could ever fire;
  // the screen simply waits forever. A deadline on the WAIT catches it anyway,
  // which is the whole argument for putting it there.
  it('speaks up even when the request is never made at all', async () => {
    onlineManager.setOnline(false);
    mockedGetCurrentUser.mockReturnValue(neverSettles());

    renderCastScreen();
    await advance(CAST_LOAD_TIMEOUT_MS);

    expect(mockedGetCurrentUser).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/no respondió a tiempo/i);
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  // A real diagnosis must survive the clock. Replacing "the link went stale"
  // with a generic "no answer" twenty seconds later would send whoever is
  // standing there to go restart a router over an expired token.
  it('never overwrites a real error with the generic timeout message', async () => {
    mockedGetCurrentUser.mockRejectedValue(new ApiError(401, 'Unauthorized'));

    renderCastScreen();
    await flush();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/ya no sirve/i);

    await advance(CAST_LOAD_TIMEOUT_MS * 2);

    expect(screen.getByRole('alert')).toHaveTextContent(/ya no sirve/i);
    expect(screen.queryByText(/no respondió a tiempo/i)).not.toBeInTheDocument();
    // And nothing to press: this one is fixed on the phone, not here.
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  // What this pins is the OUTCOME - a playing television is never replaced by
  // an error card - and it is honest about which mechanism earns that: the
  // ORDER of the returns in `CastScreen`, since the expired branch lives
  // inside `!playback.data`. A watchdog left armed behind the video would not
  // fail this test, and that is fine: the test exists so that MOVING the
  // expired branch above the video does. (The disarming itself is pinned in
  // `useCastLoadWatchdog.test.ts`, where it is observable.)
  it('does not fire behind a video that is already playing', async () => {
    mockedGetCurrentUser.mockResolvedValue(VIEWER);
    stubPlayableItem();

    renderCastScreen();
    await flush();
    await flush();
    expect(screen.getByTestId('pf-video')).toBeInTheDocument();

    await advance(CAST_LOAD_TIMEOUT_MS * 3);

    expect(screen.getByTestId('pf-video')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
