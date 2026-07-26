import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackScreen } from './TrackScreen';
import { NowPlayingBar } from './NowPlayingBar';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getItems } from '../../api/jellyfin';

vi.mock('../../api/jellyfin', () => ({
  getItem: vi.fn(),
  getItems: vi.fn(),
}));

const mockedGetItem = vi.mocked(getItem);
const mockedGetItems = vi.mocked(getItems);

// Default: the artist has no other songs, so the "Más de {artista}" section is
// hidden. Tests that exercise the section override this per-case.
const EMPTY_QUERY_RESULT = { Items: [], TotalRecordCount: 0, StartIndex: 0 };

const TRACK = {
  Id: 'tr-1',
  Name: 'Midnight City',
  Artists: ['M83'],
  AlbumArtist: 'M83',
  Album: 'Hurry Up, We’re Dreaming',
  AlbumId: 'alb-9',
  ArtistItems: [{ Id: 'art-7', Name: 'M83' }],
  Genres: ['Synthpop', 'Electronic'],
  ProductionYear: 2011,
  RunTimeTicks: 2_405_000_000,
  ImageTags: { Primary: 'tag-1' },
};

function renderTrack() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/musica/track/tr-1']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MusicPlayerProvider>
            <Routes>
              <Route path="/musica/track/:id" element={<TrackScreen />} />
            </Routes>
            <NowPlayingBar />
          </MusicPlayerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('TrackScreen (Música — track detail)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItem.mockReset();
    mockedGetItems.mockReset();
  });

  beforeEach(() => {
    // No sibling songs unless a test asks for them.
    mockedGetItems.mockResolvedValue(EMPTY_QUERY_RESULT as never);
  });

  it('renders the track info + fetches the single Audio item by id', async () => {
    mockedGetItem.mockResolvedValue(TRACK as never);
    renderTrack();

    expect(await screen.findByRole('heading', { name: 'Midnight City' })).toBeInTheDocument();
    // Artist(s), album, genre, year and duration are all shown.
    expect(screen.getByText('M83')).toBeInTheDocument();
    expect(screen.getByText('Hurry Up, We’re Dreaming')).toBeInTheDocument();
    expect(screen.getByText('Synthpop, Electronic')).toBeInTheDocument();
    expect(screen.getByText('2011')).toBeInTheDocument();
    expect(screen.getByText('4:00')).toBeInTheDocument();

    expect(mockedGetItem).toHaveBeenCalledWith(
      'user-1',
      'tr-1',
      expect.stringContaining('ArtistItems'),
    );
  });

  it('links to the artist and album using the item ids', async () => {
    mockedGetItem.mockResolvedValue(TRACK as never);
    renderTrack();

    await screen.findByRole('heading', { name: 'Midnight City' });

    expect(screen.getByRole('link', { name: 'Ir al artista' })).toHaveAttribute(
      'href',
      '/musica/artist/art-7',
    );
    expect(screen.getByRole('link', { name: 'Ver álbum' })).toHaveAttribute(
      'href',
      '/musica/album/alb-9',
    );
  });

  it('omits the "Ir al artista" link when the item has no ArtistItems', async () => {
    mockedGetItem.mockResolvedValue({ ...TRACK, ArtistItems: null } as never);
    renderTrack();

    await screen.findByRole('heading', { name: 'Midnight City' });
    expect(screen.queryByRole('link', { name: 'Ir al artista' })).not.toBeInTheDocument();
    // Album link is unaffected by the missing artist id.
    expect(screen.getByRole('link', { name: 'Ver álbum' })).toBeInTheDocument();
  });

  it('"Reproducir" plays the single track through the persistent bar (playNow)', async () => {
    mockedGetItem.mockResolvedValue(TRACK as never);
    renderTrack();

    await screen.findByRole('heading', { name: 'Midnight City' });
    expect(screen.queryByRole('region', { name: /reproduciendo ahora/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir' }));

    const bar = await screen.findByRole('region', { name: /reproduciendo ahora/i });
    await waitFor(() => expect(within(bar).getByText('Midnight City')).toBeInTheDocument());
  });

  it('renders a "Más de {artista}" section with the artist\'s other songs, excluding the current track', async () => {
    mockedGetItem.mockResolvedValue(TRACK as never);
    mockedGetItems.mockResolvedValue({
      Items: [
        // The current track comes back in the artist query and must be excluded.
        { Id: 'tr-1', Name: 'Midnight City', Artists: ['M83'], AlbumArtist: 'M83' },
        { Id: 'tr-2', Name: 'Outro', Artists: ['M83'], AlbumArtist: 'M83' },
        { Id: 'tr-3', Name: 'Reunion', Artists: ['M83'], AlbumArtist: 'M83' },
      ],
      TotalRecordCount: 3,
      StartIndex: 0,
    } as never);
    renderTrack();

    await screen.findByRole('heading', { name: 'Midnight City' });

    const section = await screen.findByRole('region', { name: 'Más de M83' });
    expect(within(section).getByRole('heading', { name: 'Más de M83' })).toBeInTheDocument();

    // The two OTHER songs appear; the current track is excluded from the section.
    expect(within(section).getByText('Outro')).toBeInTheDocument();
    expect(within(section).getByText('Reunion')).toBeInTheDocument();
    expect(within(section).queryByText('Midnight City')).not.toBeInTheDocument();

    // Queried by the current track's first credited artist id.
    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ albumArtistIds: 'art-7', includeItemTypes: 'Audio' }),
    );
  });

  it('a section row\'s play button plays that artist song through the bar (playNow)', async () => {
    mockedGetItem.mockResolvedValue(TRACK as never);
    mockedGetItems.mockResolvedValue({
      Items: [
        { Id: 'tr-2', Name: 'Outro', Artists: ['M83'], AlbumArtist: 'M83' },
        { Id: 'tr-3', Name: 'Reunion', Artists: ['M83'], AlbumArtist: 'M83' },
      ],
      TotalRecordCount: 2,
      StartIndex: 0,
    } as never);
    renderTrack();

    const section = await screen.findByRole('region', { name: 'Más de M83' });
    fireEvent.click(within(section).getByRole('button', { name: 'Reproducir Reunion' }));

    const bar = await screen.findByRole('region', { name: /reproduciendo ahora/i });
    await waitFor(() => expect(within(bar).getByText('Reunion')).toBeInTheDocument());
  });

  it('hides the "Más de {artista}" section when the artist has no other songs', async () => {
    mockedGetItem.mockResolvedValue(TRACK as never);
    // Only the current track comes back -> nothing left after excluding it.
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'tr-1', Name: 'Midnight City', Artists: ['M83'] }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    renderTrack();

    await screen.findByRole('heading', { name: 'Midnight City' });
    expect(screen.queryByRole('region', { name: /^Más de/ })).not.toBeInTheDocument();
  });
});
