import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  gameCoverUrl: (id: string) => `/bff/games/cover?id=${id}`,
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

  it('offers the search box as soon as there is a library to search', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    renderScreen();

    await screen.findByRole('link', { name: /Super Metroid/ });
    // A catalogue's search box is not a reward for owning enough games: if it
    // only appears past a threshold, nobody ever learns it is there.
    expect(screen.getByRole('searchbox', { name: 'Buscar' })).toBeInTheDocument();
  });

  it('filters by title, ignoring case', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const user = userEvent.setup();
    renderScreen();

    const box = await screen.findByRole('searchbox', { name: 'Buscar' });
    await user.type(box, 'chrono');

    await waitFor(() => expect(screen.queryByText('Sonic')).not.toBeInTheDocument());
    expect(screen.getByText('Chrono Trigger')).toBeInTheDocument();
  });

  // The owner types Spanish without reaching for the accent key. "pokemon"
  // returning nothing reads as "I don't own that game", which is a lie.
  it('finds an accented title from an unaccented query, and the reverse', async () => {
    mockedGetGamesLibrary.mockResolvedValue([
      { id: 'p1', title: 'Pokémon Edición Roja', system: 'gb', sizeBytes: 1024 },
      { id: 'p2', title: 'Sonic', system: 'segaMD', sizeBytes: 1024 },
    ]);
    const user = userEvent.setup();
    renderScreen();

    const box = await screen.findByRole('searchbox', { name: 'Buscar' });
    await user.type(box, 'pokemon edicion');

    await waitFor(() => expect(screen.queryByText('Sonic')).not.toBeInTheDocument());
    expect(screen.getByText('Pokémon Edición Roja')).toBeInTheDocument();

    // …and an accented query still finds it, so neither habit is punished.
    await user.clear(box);
    await user.type(box, 'Pokémon');
    expect(await screen.findByText('Pokémon Edición Roja')).toBeInTheDocument();
  });

  it('filters by console name too', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const user = userEvent.setup();
    renderScreen();

    const box = await screen.findByRole('searchbox', { name: 'Buscar' });
    await user.type(box, 'mega drive');

    await waitFor(() => expect(screen.queryByText('Super Metroid')).not.toBeInTheDocument());
    expect(screen.getByText('Sonic')).toBeInTheDocument();
  });

  // The count is not decoration: it is the only thing that tells a user whose
  // search narrowed the shelf from 200 to 3 that it narrowed at all. It lives
  // in a live region so it is spoken, not just drawn.
  it('reports how many results a search found, out loud', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const user = userEvent.setup();
    renderScreen();

    const live = await screen.findByRole('status');
    await waitFor(() => expect(live).toHaveTextContent('3 juegos listos para jugar.'));

    const box = screen.getByRole('searchbox', { name: 'Buscar' });
    await user.type(box, 'sonic');
    await waitFor(() => expect(live).toHaveTextContent('1 juego de 3.'));

    // A search that found nothing is counted too, rather than falling silent.
    await user.clear(box);
    await user.type(box, 'castlevania');
    await waitFor(() => expect(live).toHaveTextContent('0 juegos de 3.'));
  });

  // The region has to be on the page BEFORE its text changes, or a screen
  // reader never announces the change at all — which is why it is rendered
  // empty rather than conditionally.
  it('keeps the live region mounted while there is nothing to count', async () => {
    mockedGetGamesLibrary.mockResolvedValue([]);
    renderScreen();

    await screen.findByText('Todavía no hay juegos');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('drops the consoles a search emptied instead of leaving bare headings', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const user = userEvent.setup();
    renderScreen();

    const box = await screen.findByRole('searchbox', { name: 'Buscar' });
    await user.type(box, 'sonic');

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Super Nintendo' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: 'Sega Mega Drive' })).toBeInTheDocument();
  });

  // Three different nothings. Collapsing any two of them sends the owner to
  // check a folder that is fine, or to reboot a server that is fine.
  it('tells a fruitless search apart from an empty library and from a dead server', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const user = userEvent.setup();
    renderScreen();

    const box = await screen.findByRole('searchbox', { name: 'Buscar' });
    await user.type(box, 'castlevania');

    expect(await screen.findByText('Sin resultados')).toBeInTheDocument();
    // Not the day-one instructions: the shelf is full, the query is the problem.
    expect(screen.queryByText('Todavía no hay juegos')).not.toBeInTheDocument();
    // Not a failure either.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // And there is a way back that does not involve clearing the box by hand.
    await user.click(screen.getByRole('button', { name: 'Ver todos los juegos' }));
    expect(await screen.findByText('Super Metroid')).toBeInTheDocument();
  });

  it('asks the cover endpoint for each game, lazily', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const { container } = renderScreen();

    await screen.findByRole('link', { name: /Super Metroid/ });
    const covers = Array.from(container.querySelectorAll('img.pf-games__cover-img'));
    expect(covers).toHaveLength(3);
    // One request per game, each carrying that game's own id.
    expect(covers.map((cover) => cover.getAttribute('src')).sort()).toEqual([
      '/bff/games/cover?id=g1',
      '/bff/games/cover?id=g2',
      '/bff/games/cover?id=g3',
    ]);
    // A shelf of two hundred cartridges must not ask for two hundred images.
    expect(covers.every((cover) => cover.getAttribute('loading') === 'lazy')).toBe(true);
  });

  // Most ROM folders have no cover art, so the 404 path is the common one.
  it('falls back to a named placeholder when a cover 404s', async () => {
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
    const { container } = renderScreen();

    await screen.findByRole('link', { name: /Super Metroid/ });
    const cover = container.querySelector(
      'img.pf-games__cover-img[src="/bff/games/cover?id=g1"]',
    ) as HTMLImageElement;

    fireEvent.error(cover);

    await waitFor(() =>
      expect(
        container.querySelector('img.pf-games__cover-img[src="/bff/games/cover?id=g1"]'),
      ).toBeNull(),
    );
    // The card still shows the game, not a hole and not a broken-image glyph.
    const fallback = container.querySelector('.pf-games__cover-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveTextContent('Super Metroid');
    // The other two covers are untouched: one 404 is not a shelf-wide failure.
    expect(container.querySelectorAll('img.pf-games__cover-img')).toHaveLength(2);
  });
});
