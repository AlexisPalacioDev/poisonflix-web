import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicScreen } from './MusicScreen';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import {
  searchMusic,
  requestDownload,
  getMusicJob,
  getRecommendations,
  requestPlaylist,
  getPlaylistBatch,
} from '../../api/music';
import { getItems, getPlayedAudio } from '../../api/jellyfin';

vi.mock('../../api/music', () => ({
  searchMusic: vi.fn(),
  requestDownload: vi.fn(),
  getMusicJob: vi.fn(),
  getRecommendations: vi.fn(),
  requestPlaylist: vi.fn(),
  getPlaylistBatch: vi.fn(),
}));
vi.mock('../../api/jellyfin', () => ({
  getItems: vi.fn(),
  // The personalised feed reads this user's play history; the rows below cover
  // the cold-start path, where it comes back empty.
  getPlayedAudio: vi.fn(),
}));

const mockedSearchMusic = vi.mocked(searchMusic);
const mockedRequestDownload = vi.mocked(requestDownload);
const mockedGetMusicJob = vi.mocked(getMusicJob);
const mockedGetRecommendations = vi.mocked(getRecommendations);
const mockedRequestPlaylist = vi.mocked(requestPlaylist);
const mockedGetPlaylistBatch = vi.mocked(getPlaylistBatch);
const mockedGetItems = vi.mocked(getItems);
const mockedGetPlayedAudio = vi.mocked(getPlayedAudio);

function renderMusic() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/musica']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MusicPlayerProvider>
            <MusicScreen />
          </MusicPlayerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MusicScreen (Música — Slice 1)', () => {
  // Safe defaults so the landing hooks (recommendations, playlist) never error
  // or leak fixtures into tests that don't exercise them.
  beforeEach(() => {
    mockedGetRecommendations.mockResolvedValue([]);
    mockedGetPlayedAudio.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedRequestPlaylist.mockResolvedValue({ batchId: 'batch-1', count: 0, jobIds: [] } as never);
    mockedGetPlaylistBatch.mockResolvedValue({
      batchId: 'batch-1',
      total: 0,
      done: 0,
      failed: 0,
      jobs: [],
    } as never);
  });

  afterEach(() => {
    clearSession();
    mockedSearchMusic.mockReset();
    mockedRequestDownload.mockReset();
    mockedGetMusicJob.mockReset();
    mockedGetRecommendations.mockReset();
    mockedRequestPlaylist.mockReset();
    mockedGetPlaylistBatch.mockReset();
    mockedGetItems.mockReset();
    mockedGetPlayedAudio.mockReset();
  });

  it('shows the idle empty state below the 2-char minimum and issues no search', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    renderMusic();

    fireEvent.change(screen.getByRole('searchbox', { name: /buscar música/i }), {
      target: { value: 'a' },
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    expect(mockedSearchMusic).not.toHaveBeenCalled();
    expect(screen.getByText(/al menos 2 caracteres/i)).toBeInTheDocument();
  });

  it('debounces the query, lists YouTube Music results, and enqueues a download on Descargar', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([
      {
        type: 'song',
        videoId: 'vid-1',
        title: 'Song One',
        artist: 'The Artist',
        artists: ['The Artist'],
        album: 'The Album',
        durationSeconds: 200,
        thumbnailUrl: null,
        source: 'ytmusic',
      },
    ] as never);
    mockedRequestDownload.mockResolvedValue({ jobId: 'job-1', state: 'queued' } as never);
    mockedGetMusicJob.mockResolvedValue({
      id: 'job-1',
      state: 'done',
      error: null,
      videoId: 'vid-1',
      jellyfinItemId: null,
    } as never);

    renderMusic();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar música/i }), {
      target: { value: 'song' },
    });

    await waitFor(() => expect(mockedSearchMusic).toHaveBeenCalledWith('song', 'auto'), {
      timeout: 2000,
    });

    expect(await screen.findByText('Song One')).toBeInTheDocument();
    expect(screen.getByText('The Artist · The Album')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para Song One' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Descargar' }));

    await waitFor(() =>
      expect(mockedRequestDownload).toHaveBeenCalledWith({
        videoId: 'vid-1',
        title: 'Song One',
        artist: 'The Artist',
        album: 'The Album',
      }),
    );
  });

  it('seeds a radio of related tracks when a search hit starts playing', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([
      {
        type: 'song',
        videoId: 'vid-1',
        title: 'Song One',
        artist: 'The Artist',
        artists: ['The Artist'],
        album: 'The Album',
        durationSeconds: 200,
        thumbnailUrl: null,
        source: 'ytmusic',
      },
    ] as never);

    renderMusic();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar música/i }), {
      target: { value: 'song' },
    });
    expect(await screen.findByText('Song One')).toBeInTheDocument();

    // The hit isn't downloaded, so its play button is the "sin descargar"
    // preview — the radio has to fire on that path too, not only on library hits.
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir Song One sin descargar' }));

    await waitFor(() => expect(mockedGetRecommendations).toHaveBeenCalledWith('vid-1', 15));
  });

  it('renders the Jellyfin Audio library under the Canciones tab, newest first', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [
        { Id: 'aud-1', Name: 'My Track', Artists: ['Me'], AlbumArtist: 'Me', ImageTags: null },
      ],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedSearchMusic.mockResolvedValue([] as never);

    renderMusic();

    expect(await screen.findByText('My Track')).toBeInTheDocument();
    // The row/cover/title is a link to the track detail, separate from the play
    // button that still plays the song.
    expect(screen.getByRole('link', { name: /ver my track/i })).toHaveAttribute(
      'href',
      '/musica/track/aud-1',
    );
    expect(screen.getByRole('button', { name: /reproducir my track/i })).toBeInTheDocument();
    // Library read goes straight through the Jellyfin proxy for Audio items.
    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ includeItemTypes: 'Audio', sortBy: 'DateCreated' }),
    );
  });

  it('switches to the Álbumes / Artistas tabs, lazily querying each item type', async () => {
    // One resolver for every getItems call, keyed on the requested item type,
    // so each browse tab sees only its own items.
    mockedGetItems.mockImplementation((_userId, params) => {
      const type = (params as { includeItemTypes?: string } | undefined)?.includeItemTypes;
      if (type === 'MusicAlbum') {
        return Promise.resolve({
          Items: [{ Id: 'alb-1', Name: 'Greatest Hits', AlbumArtist: 'The Band', ImageTags: null }],
          TotalRecordCount: 1,
          StartIndex: 0,
        }) as never;
      }
      if (type === 'MusicArtist') {
        return Promise.resolve({
          Items: [{ Id: 'art-1', Name: 'The Band', ImageTags: null }],
          TotalRecordCount: 1,
          StartIndex: 0,
        }) as never;
      }
      return Promise.resolve({ Items: [], TotalRecordCount: 0, StartIndex: 0 }) as never;
    });
    mockedSearchMusic.mockResolvedValue([] as never);

    renderMusic();

    // Canciones is the default tab: neither album nor artist query has fired.
    expect(mockedGetItems).not.toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ includeItemTypes: 'MusicAlbum' }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Álbumes' }));

    const albumLink = await screen.findByRole('link', { name: /greatest hits/i });
    expect(albumLink).toHaveAttribute('href', '/musica/album/alb-1');
    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ includeItemTypes: 'MusicAlbum', recursive: true }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Artistas' }));

    const artistLink = await screen.findByRole('link', { name: /the band/i });
    expect(artistLink).toHaveAttribute('href', '/musica/artist/art-1');
    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ includeItemTypes: 'MusicArtist', recursive: true }),
    );
  });

  it('source toggle: switching to YouTube searches that surface', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([] as never);

    renderMusic();

    // Flip the segmented control to YouTube, then type a query.
    fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar música/i }), {
      target: { value: 'song' },
    });

    await waitFor(() => expect(mockedSearchMusic).toHaveBeenCalledWith('song', 'youtube'), {
      timeout: 2000,
    });
  });

  it('renders the "Recomendados para ti" row from the recommendations feed', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([] as never);
    mockedGetRecommendations.mockResolvedValue([
      {
        type: 'song',
        videoId: 'rec-1',
        title: 'Recommended Jam',
        artist: 'Rec Artist',
        artists: ['Rec Artist'],
        album: null,
        durationSeconds: 180,
        thumbnailUrl: null,
        source: 'ytmusic',
      },
    ] as never);

    renderMusic();

    expect(await screen.findByText('Recomendados para ti')).toBeInTheDocument();
    expect(await screen.findByText('Recommended Jam')).toBeInTheDocument();
  });

  it('Géneros tab renders the genre chips from Jellyfin', async () => {
    mockedGetItems.mockImplementation((_userId, params) => {
      const type = (params as { includeItemTypes?: string } | undefined)?.includeItemTypes;
      if (type === 'MusicGenre') {
        return Promise.resolve({
          Items: [{ Id: 'g1', Name: 'Rock', ImageTags: null }],
          TotalRecordCount: 1,
          StartIndex: 0,
        }) as never;
      }
      return Promise.resolve({ Items: [], TotalRecordCount: 0, StartIndex: 0 }) as never;
    });
    mockedSearchMusic.mockResolvedValue([] as never);

    renderMusic();

    fireEvent.click(screen.getByRole('tab', { name: 'Géneros' }));

    expect(await screen.findByRole('button', { name: 'Rock' })).toBeInTheDocument();
    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ includeItemTypes: 'MusicGenre' }),
    );
  });

  it('has no paste-a-URL playlist input on the landing', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([] as never);

    renderMusic();

    // The old "Descargar playlist" URL block is gone — playlists arrive as cards.
    await waitFor(() => expect(screen.queryByText('Recomendados para ti')).not.toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: /url de la playlist/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Descargar playlist')).not.toBeInTheDocument();
  });

  it('renders a playlist search result as a card whose "Descargar" downloads the batch', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([
      {
        type: 'playlist',
        playlistId: 'PL777',
        title: 'Road Trip Mix',
        author: 'DJ Mendez',
        thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
        trackCount: 12,
      },
    ] as never);
    mockedRequestPlaylist.mockResolvedValue({
      batchId: 'batch-9',
      count: 12,
      jobIds: [],
    } as never);

    renderMusic();

    fireEvent.change(screen.getByRole('searchbox', { name: /buscar música/i }), {
      target: { value: 'road' },
    });

    // The collection card shows title, kind badge, track-count label and cover.
    expect(await screen.findByText('Road Trip Mix')).toBeInTheDocument();
    expect(screen.getByText('Playlist')).toBeInTheDocument();
    expect(screen.getByText(/12 temas/)).toBeInTheDocument();
    const cover = document.querySelector(
      'img[src="https://i.ytimg.com/vi/abc/hqdefault.jpg"]',
    ) as HTMLImageElement | null;
    expect(cover).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /descargar playlist road trip mix/i }));

    await waitFor(() => expect(mockedRequestPlaylist).toHaveBeenCalledWith({ playlistId: 'PL777' }));
  });

  it('renders an album search result as a card whose "Descargar" downloads by browseId', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedSearchMusic.mockResolvedValue([
      {
        type: 'album',
        browseId: 'MPREb_123',
        title: 'Neon Dreams',
        artist: 'The Band',
        thumbnailUrl: 'https://i.ytimg.com/vi/xyz/hqdefault.jpg',
        trackCount: 1,
        year: 2024,
      },
    ] as never);
    mockedRequestPlaylist.mockResolvedValue({
      batchId: 'batch-10',
      count: 1,
      jobIds: [],
    } as never);

    renderMusic();

    fireEvent.change(screen.getByRole('searchbox', { name: /buscar música/i }), {
      target: { value: 'neon' },
    });

    expect(await screen.findByText('Neon Dreams')).toBeInTheDocument();
    expect(screen.getByText('Álbum')).toBeInTheDocument();
    // A single-track collection uses the singular "tema".
    expect(screen.getByText(/1 tema · 2024/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /descargar álbum neon dreams/i }));

    await waitFor(() =>
      expect(mockedRequestPlaylist).toHaveBeenCalledWith({ browseId: 'MPREb_123' }),
    );
  });
});
