import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamePlayerScreen } from './GamePlayerScreen';
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
  { id: 'zelda', title: 'A Link to the Past', system: 'snes', sizeBytes: 1024 },
  { id: 'mario64', title: 'Super Mario 64', system: 'n64', sizeBytes: 2048 },
];

type MutableWindow = Window & Record<string, unknown>;

/** `window`, addressable by key.
 *
 * The cast goes through `unknown` on purpose: `Window` has no index signature,
 * so TypeScript rejects the direct conversion (TS2352). One helper says that
 * once instead of fifteen bare casts repeating it — and the bare version type
 * checked under the root tsconfig, which references the real projects and
 * checks no files itself, so it only surfaced in `npm run build`. */
const mut = (): MutableWindow => window as unknown as MutableWindow;

function ejsGlobals(): string[] {
  return Object.keys(mut()).filter((key) => key.startsWith('EJS_'));
}

function loaderScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/emulatorjs/"]'));
}

function renderPlayer(id: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/juegos/play/${id}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/juegos/play/:id" element={<GamePlayerScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GamePlayerScreen', () => {
  beforeEach(() => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetGamesLibrary.mockResolvedValue(LIBRARY);
  });

  afterEach(() => {
    clearSession();
    vi.clearAllMocks();
    for (const key of ejsGlobals()) delete mut()[key];
    loaderScripts().forEach((node) => node.remove());
  });

  it('boots the game the URL names, on the console the library says it belongs to', async () => {
    renderPlayer('zelda');

    await screen.findByTestId('game-canvas');

    const w = mut();
    expect(w.EJS_core).toBe('snes');
    expect(w.EJS_gameUrl).toBe('/bff/games/rom?id=zelda');
    expect(w.EJS_player).toBe('#game');
    expect(loaderScripts()).toHaveLength(1);
  });

  // The reason `emulatorjs.ts` exists. EmulatorJS is configured through
  // globals, so a screen that leaves them behind hands its configuration to
  // whatever mounts next: you tap Mario and Zelda boots.
  it('leaves nothing behind when it unmounts', async () => {
    const { unmount } = renderPlayer('zelda');
    await screen.findByTestId('game-canvas');
    // Stand-in for the instance the library publishes once it has loaded.
    mut().EJS_emulator = {};

    unmount();

    expect(ejsGlobals()).toEqual([]);
    expect(loaderScripts()).toHaveLength(0);
  });

  it('a second game after the first starts the second game', async () => {
    const first = renderPlayer('zelda');
    await screen.findByTestId('game-canvas');
    first.unmount();

    renderPlayer('mario64');
    await screen.findByTestId('game-canvas');

    const w = mut();
    expect(w.EJS_core).toBe('n64');
    expect(w.EJS_gameUrl).toBe('/bff/games/rom?id=mario64');
  });

  // React Query refetches on window focus, and a background refetch that fails
  // leaves `isError` true with the cached library intact. Rendering the error
  // ahead of the game would unmount the canvas out from under someone mid-level
  // — and since `id`/`core`/`title` never changed, the effect would not re-run,
  // so the emulator would keep running inside a node nobody can see.
  it('a failed background refetch does not tear the running game down', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/juegos/play/zelda']}>
          <AuthProvider>
            <Routes>
              <Route path="/juegos/play/:id" element={<GamePlayerScreen />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('game-canvas');

    mockedGetGamesLibrary.mockRejectedValue(new Error('bff blinked'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['games', 'library'] });
    });

    expect(screen.getByTestId('game-canvas')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mut().EJS_core).toBe('snes');
  });

  it('never boots anything for an id the library does not have', async () => {
    renderPlayer('deleted-rom');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ese juego ya no está en el servidor.',
    );
    expect(ejsGlobals()).toEqual([]);
    expect(loaderScripts()).toHaveLength(0);
  });
});
