import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlbumScreen } from './AlbumScreen';
import { NowPlayingBar } from './NowPlayingBar';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItems } from '../../api/jellyfin';

vi.mock('../../api/jellyfin', () => ({
  getItems: vi.fn(),
}));

const mockedGetItems = vi.mocked(getItems);

const ALBUM_TRACKS = {
  Items: [
    {
      Id: 't1',
      Name: 'Track A',
      Album: 'Greatest Hits',
      AlbumArtist: 'The Band',
      Artists: ['The Band'],
      IndexNumber: 1,
      RunTimeTicks: 2_000_000_000,
      ImageTags: { Primary: 'tag-1' },
    },
    {
      Id: 't2',
      Name: 'Track B',
      Album: 'Greatest Hits',
      AlbumArtist: 'The Band',
      Artists: ['The Band'],
      IndexNumber: 2,
      RunTimeTicks: 1_800_000_000,
      ImageTags: null,
    },
  ],
  TotalRecordCount: 2,
  StartIndex: 0,
};

function renderAlbum() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/musica/album/alb-1']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MusicPlayerProvider>
            <Routes>
              <Route path="/musica/album/:id" element={<AlbumScreen />} />
            </Routes>
            <NowPlayingBar />
          </MusicPlayerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AlbumScreen (Música — Slice 3)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
  });

  it('renders the album header + tracks and queries the album by parentId', async () => {
    mockedGetItems.mockResolvedValue(ALBUM_TRACKS as never);
    renderAlbum();

    expect(await screen.findByRole('heading', { name: 'Greatest Hits' })).toBeInTheDocument();
    // Album artist shows in the header and again as each track's subtitle.
    expect(screen.getAllByText('The Band').length).toBeGreaterThan(0);
    expect(screen.getByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();

    // Track list read: the album's Audio children in disc/track order.
    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        parentId: 'alb-1',
        includeItemTypes: 'Audio',
        sortBy: 'ParentIndexNumber,IndexNumber',
      }),
    );
  });

  it('a track title links to its detail page while the play button still plays it', async () => {
    mockedGetItems.mockResolvedValue(ALBUM_TRACKS as never);
    renderAlbum();

    await screen.findByText('Track A');

    // Row/title is a real link to the track detail (open detail, not play).
    expect(screen.getByRole('link', { name: 'Ver Track A' })).toHaveAttribute(
      'href',
      '/musica/track/t1',
    );

    // The separate play button still plays the track (bar appears with Track B).
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir Track B' }));
    const bar = await screen.findByRole('region', { name: /reproduciendo ahora/i });
    await waitFor(() => expect(within(bar).getByText('Track B')).toBeInTheDocument());
  });

  it('each track play control is an icon button (aria-label kept, no visible "Reproducir" text)', async () => {
    mockedGetItems.mockResolvedValue(ALBUM_TRACKS as never);
    renderAlbum();

    await screen.findByText('Track A');

    // The per-row play control keeps its accessible label but shows no text —
    // it's the compact ▶ icon button, not the old "Reproducir" pill.
    const play = screen.getByRole('button', { name: 'Reproducir Track A' });
    expect(play).toHaveTextContent('');
    expect(play.querySelector('svg')).not.toBeNull();
  });

  it('"Reproducir álbum" plays the whole album from the first track (playNow)', async () => {
    mockedGetItems.mockResolvedValue(ALBUM_TRACKS as never);
    renderAlbum();

    // Wait for the tracks to load so the play button is enabled.
    await screen.findByText('Track A');
    // Nothing is playing yet: the persistent bar is absent.
    expect(screen.queryByRole('region', { name: /reproduciendo ahora/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir álbum' }));

    // playNow(tracks, 0) loads the queue -> the bar appears with the first track.
    const bar = await screen.findByRole('region', { name: /reproduciendo ahora/i });
    await waitFor(() => expect(within(bar).getByText('Track A')).toBeInTheDocument());
  });
});
