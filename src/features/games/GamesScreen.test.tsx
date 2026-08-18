import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamesScreen } from './GamesScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getGamesLibrary } from '../../api/games';
import type { Game } from '../../api/schemas/games';

vi.mock('../../api/games', () => ({
  getGamesLibrary: vi.fn(),
  romUrl: (id: string) => `/bff/games/rom?id=${id}`,
}));

const mockedGetGamesLibrary = vi.mocked(getGamesLibrary);

const LIBRARY: Game[] = [
  { id: 'g1', title: 'Super Metroid', system: 'snes', sizeBytes: 3 * 1024 * 1024 },
  { id: 'g2', title: 'Chrono Trigger', system: 'snes', sizeBytes: 4 * 1024 * 1024 },
  { id: 'g3', title: 'Sonic', system: 'segaMD', sizeBytes: 512 * 1024 },
];

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/juegos']}>
        <AuthProvider>
          <GamesScreen />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GamesScreen', () => {
  beforeEach(() => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  });

  afterEach(() => {
    clearSession();
    vi.clearAllMocks();
  });

  it('groups the library by console and links each game at its emulator route', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    renderScreen();

    const metroid = await screen.findByRole('link', { name: /Super Metroid/ });
    expect(metroid).toHaveAttribute('href', '/juegos/play/g1');

    // One section per console, labelled with the console's real name rather
    // than the folder name the backend uses.
    expect(screen.getByRole('region', { name: 'Super Nintendo' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sega Mega Drive' })).toBeInTheDocument();

    // Games sit under their own console, not in one flat pile.
    const snes = screen.getByRole('region', { name: 'Super Nintendo' });
    expect(snes).toHaveTextContent('Chrono Trigger');
    expect(snes).not.toHaveTextContent('Sonic');
  });

  it('counts what it found', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    renderScreen();

    expect(await screen.findByText('3 juegos listos para jugar.')).toBeInTheDocument();
  });

  // The library is empty for everyone on day one. An empty screen that says
  // nothing is indistinguishable from a broken one, so this is the screen's
  // most important state, not its least.
  it('when empty, says exactly where the ROMs go', async () => {
    mockedGetGamesLibrary.mockResolvedValue([]);
    renderScreen();

    expect(await screen.findByText('Todavía no hay juegos')).toBeInTheDocument();
    expect(screen.getByText('${DATA_DIR}/games/<sistema>/')).toBeInTheDocument();
    // …and which folder names it will recognise, since "<sistema>" alone is
    // not an instruction anyone can follow.
    expect(screen.getByText('snes')).toBeInTheDocument();
    expect(screen.getByText('segaMD')).toBeInTheDocument();
  });

  it('surfaces a read failure instead of pretending the shelf is empty', async () => {
    mockedGetGamesLibrary.mockRejectedValue(new Error('bff down'));
    renderScreen();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudo leer la biblioteca de juegos.');
    // Crucially NOT the "no hay juegos" copy - that would send the owner to
    // check a folder that is fine.
    expect(screen.queryByText('Todavía no hay juegos')).not.toBeInTheDocument();
  });

  // Same rule as the player: a background refetch that fails leaves `isError`
  // true with the shelf still in memory. Hiding rows we are holding would be a
  // lie about what is on the server.
  it('a failed background refetch does not hide a library already in memory', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/juegos']}>
          <AuthProvider>
            <GamesScreen />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('link', { name: /Super Metroid/ });

    mockedGetGamesLibrary.mockRejectedValue(new Error('bff blinked'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['games', 'library'] });
    });

    expect(screen.getByRole('link', { name: /Super Metroid/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the filter until there is enough to need one', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    renderScreen();

    await screen.findByRole('link', { name: /Super Metroid/ });
    expect(screen.queryByRole('searchbox', { name: 'Buscar un juego' })).not.toBeInTheDocument();
  });

  it('filters by title once the shelf is big enough to show the box', async () => {
    const many: Game[] = Array.from({ length: 13 }, (_, index) => ({
      id: `g${index}`,
      title: index === 0 ? 'Chrono Trigger' : `Juego ${index}`,
      system: 'snes',
      sizeBytes: 1024 * 1024,
    }));
    mockedGetGamesLibrary.mockResolvedValue(many);
    const user = userEvent.setup();
    renderScreen();

    const box = await screen.findByRole('searchbox', { name: 'Buscar un juego' });
    await user.type(box, 'chrono');

    await waitFor(() => expect(screen.queryByText('Juego 1')).not.toBeInTheDocument());
    expect(screen.getByText('Chrono Trigger')).toBeInTheDocument();
  });
});
