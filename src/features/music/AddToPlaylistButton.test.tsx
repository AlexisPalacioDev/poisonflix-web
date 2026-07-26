import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddToPlaylistButton } from './AddToPlaylistButton';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getUserPlaylists, addToPlaylist, createPlaylist } from '../../api/playlists';

vi.mock('../../api/playlists', () => ({
  getUserPlaylists: vi.fn(),
  addToPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
}));

const mockedGetUserPlaylists = vi.mocked(getUserPlaylists);
const mockedAddToPlaylist = vi.mocked(addToPlaylist);
const mockedCreatePlaylist = vi.mocked(createPlaylist);

function renderButton() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AddToPlaylistButton songId="song-1" songTitle="My Track" />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('AddToPlaylistButton (agregar a playlist)', () => {
  afterEach(() => {
    clearSession();
    mockedGetUserPlaylists.mockReset();
    mockedAddToPlaylist.mockReset();
    mockedCreatePlaylist.mockReset();
  });

  it('lists the user playlists and adds the song to the chosen one', async () => {
    mockedGetUserPlaylists.mockResolvedValue({
      Items: [{ Id: 'pl-1', Name: 'Road Trip' }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedAddToPlaylist.mockResolvedValue(undefined);

    renderButton();

    // The menu only fetches once opened.
    expect(mockedGetUserPlaylists).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /agregar my track a una playlist/i }));

    const item = await screen.findByRole('menuitem', { name: 'Road Trip' });
    fireEvent.click(item);

    await waitFor(() => expect(mockedAddToPlaylist).toHaveBeenCalledWith('pl-1', 'song-1'));
  });

  it('creates a new playlist seeded with the song via "Crear nueva…"', async () => {
    mockedGetUserPlaylists.mockResolvedValue({
      Items: [],
      TotalRecordCount: 0,
      StartIndex: 0,
    } as never);
    mockedCreatePlaylist.mockResolvedValue({ Id: 'pl-new' } as never);

    renderButton();

    fireEvent.click(screen.getByRole('button', { name: /agregar my track a una playlist/i }));

    fireEvent.click(await screen.findByRole('menuitem', { name: /crear nueva/i }));

    fireEvent.change(screen.getByLabelText(/nombre de la nueva playlist/i), {
      target: { value: 'Mis Favoritas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }));

    await waitFor(() =>
      expect(mockedCreatePlaylist).toHaveBeenCalledWith('Mis Favoritas', 'song-1'),
    );
  });
});
