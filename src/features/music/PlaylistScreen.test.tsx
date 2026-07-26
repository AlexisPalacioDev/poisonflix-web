import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistScreen } from './PlaylistScreen';
import { NowPlayingBar } from './NowPlayingBar';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getPlaylistTracks, getUserPlaylists } from '../../api/playlists';

vi.mock('../../api/playlists', () => ({
  getPlaylistTracks: vi.fn(),
  getUserPlaylists: vi.fn(),
  removeFromPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
}));

const mockedGetPlaylistTracks = vi.mocked(getPlaylistTracks);
const mockedGetUserPlaylists = vi.mocked(getUserPlaylists);

const PLAYLIST_TRACKS = {
  Items: [
    {
      Id: 't1',
      Name: 'Track A',
      Artists: ['The Band'],
      AlbumArtist: 'The Band',
      RunTimeTicks: 2_000_000_000,
      ImageTags: { Primary: 'tag-1' },
      PlaylistItemId: 'entry-1',
    },
    {
      Id: 't2',
      Name: 'Track B',
      Artists: ['The Band'],
      AlbumArtist: 'The Band',
      RunTimeTicks: 1_800_000_000,
      ImageTags: null,
      PlaylistItemId: 'entry-2',
    },
  ],
  TotalRecordCount: 2,
  StartIndex: 0,
};

function renderPlaylist() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/musica/playlist/pl-1']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MusicPlayerProvider>
            <Routes>
              <Route path="/musica/playlist/:id" element={<PlaylistScreen />} />
            </Routes>
            <NowPlayingBar />
          </MusicPlayerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PlaylistScreen (Playlists — detail)', () => {
  afterEach(() => {
    clearSession();
    mockedGetPlaylistTracks.mockReset();
    mockedGetUserPlaylists.mockReset();
  });

  it('renders the playlist name, track count and tracks', async () => {
    mockedGetPlaylistTracks.mockResolvedValue(PLAYLIST_TRACKS as never);
    mockedGetUserPlaylists.mockResolvedValue({
      Items: [{ Id: 'pl-1', Name: 'Road Trip' }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);

    renderPlaylist();

    expect(await screen.findByRole('heading', { name: 'Road Trip' })).toBeInTheDocument();
    expect(screen.getByText('2 temas')).toBeInTheDocument();
    expect(screen.getByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();

    // Fetched by the playlist id.
    expect(mockedGetPlaylistTracks).toHaveBeenCalledWith('pl-1');
  });

  it('"Reproducir" plays the whole playlist from the first track (playNow)', async () => {
    mockedGetPlaylistTracks.mockResolvedValue(PLAYLIST_TRACKS as never);
    mockedGetUserPlaylists.mockResolvedValue({
      Items: [{ Id: 'pl-1', Name: 'Road Trip' }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);

    renderPlaylist();

    await screen.findByText('Track A');
    expect(screen.queryByRole('region', { name: /reproduciendo ahora/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir' }));

    const bar = await screen.findByRole('region', { name: /reproduciendo ahora/i });
    await waitFor(() => expect(within(bar).getByText('Track A')).toBeInTheDocument());
  });
});
