import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NowPlayingBar } from './NowPlayingBar';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { sendJamTransport } from '../../api/jam';
import { ApiError, CorsError, NetworkError } from '../../lib/http/errors';
import type { JamTrack } from '../../api/schemas/jam';
import { setJamRoom, type JamRoomState } from '../jam/roomState';

// The bar as the control for the ROOM.
//
// This covers the bug the owner reported in one sentence: with a Jam chosen as
// the output, pressing play sent the track to the room and the screen did not
// move — no bar, no state change on the button, no sound. Every assertion here
// is about the bar reflecting and driving the room rather than the local
// element, and the first test is the symptom itself: an empty local queue must
// not stop the bar from appearing.

vi.mock('../../api/jam', () => ({
  sendJamTransport: vi.fn().mockResolvedValue(undefined),
}));

const mockedSendJamTransport = vi.mocked(sendJamTransport);

const localTracks: MusicTrack[] = [
  { itemId: 'local-a', title: 'Canción local', artist: 'Artista local', coverUrl: null },
];

function jamTrack(overrides: Partial<JamTrack> = {}): JamTrack {
  return {
    itemId: 'room-a',
    title: 'Tema de la sala',
    artist: 'Artista de la sala',
    coverUrl: null,
    durationSeconds: 200,
    addedBy: 'someone',
    ...overrides,
  };
}

function roomFixture(overrides: Partial<JamRoomState> = {}): JamRoomState {
  const queue = overrides.queue ?? [jamTrack(), jamTrack({ itemId: 'room-b', title: 'La siguiente' })];
  return {
    jamId: 'jam-1',
    name: 'Ruta a la costa',
    track: queue[0] ?? null,
    index: 0,
    queue,
    playhead: { index: 0, positionMs: 30_000, isPlaying: true, at: Date.now() },
    canControl: true,
    connected: true,
    ...overrides,
  };
}

// Force the desktop (false) or compact/mobile (true) layout, the same way
// NowPlayingBar.test.tsx does.
function setCompactViewport(isCompact: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: isCompact && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Seed({ seedTracks }: { seedTracks: MusicTrack[] }) {
  const { playNow } = useMusicPlayer();
  useEffect(() => {
    if (seedTracks.length > 0) playNow(seedTracks, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** Reports the local player's own state, so a test can prove the bar's buttons
 *  never reached it while a room was the output. */
function LocalProbe() {
  const { isPlaying, currentIndex } = useMusicPlayer();
  return (
    <div data-testid="local">
      {isPlaying ? 'playing' : 'paused'}:{currentIndex}
    </div>
  );
}

function renderBar({ seedTracks = [] as MusicTrack[], path = '/musica' } = {}) {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <MusicPlayerProvider>
            <Seed seedTracks={seedTracks} />
            <NowPlayingBar />
            <LocalProbe />
          </MusicPlayerProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function publish(room: JamRoomState | null) {
  act(() => setJamRoom(room));
}

beforeEach(() => {
  setCompactViewport(false);
  // `mockReset` rather than `mockClear`: the failure tests below install
  // one-shot rejections, and a leftover one would fail an unrelated test.
  mockedSendJamTransport.mockReset();
  mockedSendJamTransport.mockResolvedValue(undefined as never);
});

afterEach(() => {
  // Module-scope store: a room left behind would leak into the next test, and
  // into every other suite that renders this bar.
  setJamRoom(null);
  clearSession();
  vi.useRealTimers();
});

/** Let the rejected transport promise reach its handler. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('NowPlayingBar — routed to a Jam', () => {
  it('appears and shows the room even though the local queue is empty', () => {
    // The reported symptom exactly: `playNow` handed the track to the room, so
    // nothing was ever queued locally and the old bar had nothing to render.
    renderBar();
    expect(screen.queryByRole('region', { name: 'Reproduciendo ahora' })).not.toBeInTheDocument();

    publish(roomFixture());

    expect(screen.getByRole('region', { name: 'Reproduciendo ahora' })).toBeInTheDocument();
    expect(screen.getByText('Tema de la sala')).toBeInTheDocument();
    expect(screen.getByText('Ruta a la costa')).toBeInTheDocument();
    // Playing in the room, so the button offers the pause it really is.
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
  });

  it('shows the room instead of whatever the local player was left holding', () => {
    renderBar({ seedTracks: localTracks });
    expect(screen.getByText('Canción local')).toBeInTheDocument();

    publish(roomFixture());

    expect(screen.getByText('Tema de la sala')).toBeInTheDocument();
    expect(screen.queryByText('Canción local')).not.toBeInTheDocument();
  });

  it('sends pause to the room and never touches the local player', () => {
    renderBar({ seedTracks: localTracks });
    publish(roomFixture());
    const localBefore = screen.getByTestId('local').textContent;

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));

    expect(mockedSendJamTransport).toHaveBeenCalledWith('jam-1', { type: 'pause' });
    expect(screen.getByTestId('local')).toHaveTextContent(localBefore ?? '');
  });

  it('sends play when the room is paused', () => {
    renderBar();
    publish(
      roomFixture({ playhead: { index: 0, positionMs: 30_000, isPlaying: false, at: Date.now() } }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir' }));

    expect(mockedSendJamTransport).toHaveBeenCalledWith('jam-1', { type: 'play' });
  });

  it('sends prev, next and seek to the room', () => {
    renderBar();
    publish(roomFixture());

    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    fireEvent.change(screen.getByLabelText('Buscar en la pista'), { target: { value: '90' } });

    expect(mockedSendJamTransport).toHaveBeenCalledWith('jam-1', { type: 'prev' });
    expect(mockedSendJamTransport).toHaveBeenCalledWith('jam-1', { type: 'next' });
    expect(mockedSendJamTransport).toHaveBeenCalledWith('jam-1', { type: 'seek', positionMs: 90_000 });
  });

  it('reads the position off the room playhead, not off the silent local element', () => {
    renderBar();
    publish(roomFixture());

    // 30s into a 200s track, projected from `at` = now.
    expect(screen.getByText('0:30')).toBeInTheDocument();
    expect(screen.getByText('3:20')).toBeInTheDocument();
  });

  it('goes inert, visibly, for someone without transport rights', () => {
    renderBar();
    publish(roomFixture({ canControl: false }));

    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(mockedSendJamTransport).not.toHaveBeenCalled();
  });

  it('drops shuffle and repeat, which a shared room does not have', () => {
    renderBar({ seedTracks: localTracks });
    expect(screen.getByRole('button', { name: 'Aleatorio' })).toBeInTheDocument();

    publish(roomFixture());

    expect(screen.queryByRole('button', { name: 'Aleatorio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Repetir/ })).not.toBeInTheDocument();
  });

  it('opens the room queue, not this device’s, and jumps in the room', () => {
    renderBar({ seedTracks: localTracks });
    publish(roomFixture());

    fireEvent.click(screen.getByRole('button', { name: 'Cola de Ruta a la costa' }));
    const drawer = screen.getByRole('dialog', { name: 'Cola de Ruta a la costa' });
    expect(within(drawer).getByText('La siguiente')).toBeInTheDocument();
    expect(within(drawer).queryByText('Canción local')).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Reproducir La siguiente en la sala' }));
    expect(mockedSendJamTransport).toHaveBeenCalledWith('jam-1', { type: 'jump', index: 1 });
  });

  it('marks the room chip stale while the stream is down', () => {
    renderBar();
    publish(roomFixture({ connected: false }));

    expect(screen.getByText('Ruta a la costa').closest('.pf-nowplaying__room')).toHaveClass(
      'pf-nowplaying__room--stale',
    );
  });

  it('hands the bar back to the local player when the room lets go', () => {
    renderBar({ seedTracks: localTracks });
    publish(roomFixture());
    expect(screen.getByText('Tema de la sala')).toBeInTheDocument();

    publish(null);

    expect(screen.getByText('Canción local')).toBeInTheDocument();
    expect(screen.queryByText('Ruta a la costa')).not.toBeInTheDocument();
  });

  it('keeps the transport centred and reachable on the compact bar', () => {
    setCompactViewport(true);
    renderBar();
    publish(roomFixture());

    const bar = screen.getByRole('region', { name: 'Reproduciendo ahora' });
    // The three controls the compact bar used to be the only place to lose.
    expect(within(bar).getByRole('button', { name: 'Anterior' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Siguiente' })).toBeInTheDocument();
    // …plus the seek bar and the queue, which it did lose.
    expect(within(bar).getByLabelText('Buscar en la pista')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Cola de Ruta a la costa' })).toBeInTheDocument();
    // The transport lives in its own centred grid column, not pinned to an edge.
    expect(bar.querySelector('.pf-nowplaying__compact-controls')).not.toBeNull();
  });
});

// The bar is rendered by AppLayout, which wraps every authed screen, so a route
// gate inside the component is the only thing deciding where it exists. It used
// to be `pathname.startsWith('/musica')`, which left the Jam screen — the one
// place you administer a room — with no transport at all, because the room
// screen had already handed its prev/play/next to "the bar".
describe('NowPlayingBar — where the bar is allowed to exist', () => {
  const inTheMusicHalf = ['/musica', '/musica/descargas', '/musica/album/a1', '/jam'];
  const onTheCineSide = ['/', '/downloads', '/detail/42', '/player/42', '/library', '/control'];

  it.each(inTheMusicHalf)('shows the room transport on %s', (path) => {
    renderBar({ path });
    publish(roomFixture());

    const bar = screen.getByRole('region', { name: 'Reproduciendo ahora' });
    expect(within(bar).getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Anterior' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Siguiente' })).toBeInTheDocument();
  });

  it.each(onTheCineSide)('stays out of the way on %s', (path) => {
    renderBar({ path });
    publish(roomFixture());

    expect(screen.queryByRole('region', { name: 'Reproduciendo ahora' })).not.toBeInTheDocument();
  });
});

// The bug: a 403 on /transport left the bar byte-for-byte identical. No alert,
// no aria change, nothing but a console line. Every test here is about the
// person pressing the button being told, and about the telling NOT inventing
// a playback state the server never confirmed.
describe('NowPlayingBar — a transport command that does not land', () => {
  it('announces a refusal, and says it is about permission', async () => {
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/solo quien la dirige puede controlar la reproducción/i);
  });

  it('announces a dropped connection differently, because the fix is different', async () => {
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new NetworkError());

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/sin conexión/i);
  });

  // The browser cannot tell a proxy misconfiguration from a dead network, so
  // `CorsError` is a NetworkError subtype and must read the same way.
  it('treats a blocked request as a connection problem too', async () => {
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new CorsError());

    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/sin conexión/i);
  });

  it.each([
    ['a server error', new ApiError(500, 'Boom')],
    ['a room that is gone', new ApiError(404, 'Gone')],
    ['something nobody typed a class for', new Error('who knows')],
  ])('falls back to "try again" for %s', async (_label, cause) => {
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(cause);

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo enviar el comando/i);
  });

  it('invents no state: the bar still shows exactly what the room last said', async () => {
    renderBar();
    publish(roomFixture());
    const bar = screen.getByRole('region', { name: 'Reproduciendo ahora' });
    // The transport cluster, not the whole bar: the seek input's value is the
    // room's playhead projected against the wall clock, so it moves on its own
    // and says nothing about whether the press was honoured.
    const transport = bar.querySelector('.pf-nowplaying__controls') as HTMLElement;
    const before = transport.innerHTML;
    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await screen.findByRole('alert');

    // The room is still playing as far as the server is concerned, so the
    // button still offers the pause it really is.
    expect(within(bar).getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Reproducir' })).not.toBeInTheDocument();
    expect(transport.innerHTML).toBe(before);
    // …and the notice is a sibling of the bar, so it cost the bar no height.
    expect(screen.getByRole('alert').closest('.pf-nowplaying')).toBeNull();
  });

  it('clears itself once a later command is accepted', async () => {
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new NetworkError());
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  // A press that succeeds may report back AFTER a later press has already
  // failed. Clearing on any success would then tell the person their command
  // landed when the one they actually made did not.
  it('does not let a slow success erase a newer failure', async () => {
    renderBar();
    publish(roomFixture());
    let acceptTheSlowOne = () => {};
    mockedSendJamTransport.mockImplementationOnce(
      () => new Promise((resolve) => (acceptTheSlowOne = () => resolve(undefined as never))),
    );

    // Press one: still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    // Press two: fails now.
    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await screen.findByRole('alert');

    // Press one finally lands.
    await act(async () => {
      acceptTheSlowOne();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/solo quien la dirige/i);
  });

  it('re-announces an identical second failure instead of going quiet', async () => {
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    const first = await screen.findByRole('alert');

    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await settle();

    // A live region only speaks when the node is (re)inserted; same text in the
    // same node would have been silent.
    expect(screen.getByRole('alert')).not.toBe(first);
  });

  it('takes itself down after a few seconds', async () => {
    vi.useFakeTimers();
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(500, 'Boom'));

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await settle();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a jump the room refused, through the same notice', async () => {
    renderBar();
    publish(roomFixture());
    fireEvent.click(screen.getByRole('button', { name: 'Cola de Ruta a la costa' }));
    mockedSendJamTransport.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir La siguiente en la sala' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/solo quien la dirige/i);
  });

  it('shows the notice on the compact bar too', async () => {
    setCompactViewport(true);
    renderBar();
    publish(roomFixture());
    mockedSendJamTransport.mockRejectedValueOnce(new NetworkError());

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/sin conexión/i);
  });
});
