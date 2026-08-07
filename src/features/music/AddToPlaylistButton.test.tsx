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

  // Shared dismissal via OverlayShell (design D: `sdd/mobile-music-overhaul`).
  describe('shared dismissal', () => {
    afterEach(() => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
    });

    it('closes on Escape', async () => {
      mockedGetUserPlaylists.mockResolvedValue({
        Items: [],
        TotalRecordCount: 0,
        StartIndex: 0,
      } as never);
      renderButton();

      fireEvent.click(screen.getByRole('button', { name: /agregar my track a una playlist/i }));
      expect(await screen.findByRole('menu')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes when clicking the backdrop', async () => {
      mockedGetUserPlaylists.mockResolvedValue({
        Items: [],
        TotalRecordCount: 0,
        StartIndex: 0,
      } as never);
      renderButton();

      fireEvent.click(screen.getByRole('button', { name: /agregar my track a una playlist/i }));
      expect(await screen.findByRole('menu')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cerrar menú' }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('locks body scroll while open and releases it on close', async () => {
      mockedGetUserPlaylists.mockResolvedValue({
        Items: [],
        TotalRecordCount: 0,
        StartIndex: 0,
      } as never);
      renderButton();

      fireEvent.click(screen.getByRole('button', { name: /agregar my track a una playlist/i }));
      await screen.findByRole('menu');
      expect(document.body.style.position).toBe('fixed');

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.body.style.position).toBe('');
    });

    it('returns focus to the "+" trigger once closed', async () => {
      mockedGetUserPlaylists.mockResolvedValue({
        Items: [],
        TotalRecordCount: 0,
        StartIndex: 0,
      } as never);
      renderButton();

      const trigger = screen.getByRole('button', { name: /agregar my track a una playlist/i });
      trigger.focus();
      fireEvent.click(trigger);
      await screen.findByRole('menu');

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(trigger).toHaveFocus();
    });

    // See the equivalent test in `MusicRowMenu.test.tsx` for the full
    // rationale (unconfirmed audit suspicion, same root cause as the
    // confirmed Header blocker - a hover `transform` on the parent row can
    // trap a non-portalled panel below a body-portalled backdrop). jsdom
    // applies no CSS, so this only proves the structural invariant, not the
    // visual result.
    it('portals the anchored panel outside its own local wrapper (immune to an ancestor stacking context)', async () => {
      mockedGetUserPlaylists.mockResolvedValue({
        Items: [],
        TotalRecordCount: 0,
        StartIndex: 0,
      } as never);
      renderButton();

      const trigger = screen.getByRole('button', { name: /agregar my track a una playlist/i });
      fireEvent.click(trigger);
      const panel = await screen.findByRole('menu');
      const localWrapper = trigger.closest('.pf-music__addpl');

      expect(localWrapper).not.toBeNull();
      expect(localWrapper?.contains(panel)).toBe(false);
      expect(panel.parentElement?.parentElement).toBe(document.body);
    });
  });
});
