import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useParams, useRoutes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailScreen } from './DetailScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getItems } from '../../api/jellyfin';
import { deleteRequest, getMovieDetails, getRequests, getTvDetails, requestMedia } from '../../api/jellyseerr';
import {
  deleteRadarrMovie,
  deleteSonarrSeries,
  getRadarrMovies,
  getRadarrQueue,
  getSonarrEpisodes,
  getSonarrQueue,
  getSonarrSeries,
} from '../../api/arr';

vi.mock('../../api/jellyfin', () => ({
  getItems: vi.fn(),
  getItem: vi.fn(),
  getUserViews: vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
}));
vi.mock('../../api/jellyseerr', () => ({
  getMovieDetails: vi.fn(),
  getTvDetails: vi.fn(),
  requestMedia: vi.fn(),
  getRequests: vi.fn(),
  deleteRequest: vi.fn(),
}));
vi.mock('../../api/arr', () => ({
  getRadarrMovies: vi.fn(),
  getRadarrQueue: vi.fn(),
  deleteRadarrMovie: vi.fn(),
  getRadarrMovieRaw: vi.fn(),
  putRadarrMovieRaw: vi.fn(),
  deleteRadarrQueueItem: vi.fn(),
  getSonarrSeries: vi.fn(),
  getSonarrEpisodes: vi.fn(),
  getSonarrQueue: vi.fn(),
  deleteSonarrSeries: vi.fn(),
  deleteSonarrQueueItem: vi.fn(),
  putSonarrEpisodesMonitor: vi.fn(),
}));

const mockedGetItems = vi.mocked(getItems);
const mockedGetItem = vi.mocked(getItem);
const mockedGetMovieDetails = vi.mocked(getMovieDetails);
const mockedGetTvDetails = vi.mocked(getTvDetails);
const mockedRequestMedia = vi.mocked(requestMedia);
const mockedGetRequests = vi.mocked(getRequests);
const mockedDeleteRequest = vi.mocked(deleteRequest);
const mockedGetRadarrMovies = vi.mocked(getRadarrMovies);
const mockedGetRadarrQueue = vi.mocked(getRadarrQueue);
const mockedDeleteRadarrMovie = vi.mocked(deleteRadarrMovie);
const mockedGetSonarrSeries = vi.mocked(getSonarrSeries);
const mockedGetSonarrEpisodes = vi.mocked(getSonarrEpisodes);
const mockedGetSonarrQueue = vi.mocked(getSonarrQueue);
const mockedDeleteSonarrSeries = vi.mocked(deleteSonarrSeries);

const EMPTY_LIBRARY = { Items: [], TotalRecordCount: 0, StartIndex: 0 };

// Shared defaults for every test in this file - the Detail enhancements
// (Audio disponible, live-% polling, delete/cancel) all fetch Jellyfin/Radarr/
// Sonarr/Jellyseerr data that pre-existing tests never had to mock. Sonarr is
// 401-gated in the real dev environment (task constraint); resolving it to
// empty here exercises the exact same graceful-degradation path.
beforeEach(() => {
  mockedGetItem.mockResolvedValue({ Id: 'jf-item', Name: 'Item', MediaStreams: [] } as never);
  mockedGetRequests.mockResolvedValue({ pageInfo: null, results: [] } as never);
  mockedGetRadarrMovies.mockResolvedValue([]);
  mockedGetRadarrQueue.mockResolvedValue({ records: [] } as never);
  mockedGetSonarrSeries.mockResolvedValue([]);
  mockedGetSonarrQueue.mockResolvedValue({ records: [] } as never);
  mockedGetSonarrEpisodes.mockResolvedValue([]);
});

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 603,
    title: 'The Matrix',
    overview: 'A hacker discovers reality is a simulation.',
    releaseDate: '1999-03-30',
    posterPath: '/matrix.jpg',
    backdropPath: '/matrix-backdrop.jpg',
    voteAverage: 8.2,
    runtime: 136,
    mediaInfo: null,
    ...overrides,
  };
}

/** Test-only stand-in for PlayerScreen so navigation from "Reproducir" is observable. */
function TestPlayerScreen() {
  const { id } = useParams<{ id: string }>();
  return <p>player-screen:{id}</p>;
}

function TestRouteTree() {
  return useRoutes([
    { path: '/detail/:id', element: <DetailScreen /> },
    { path: '/player/:id', element: <TestPlayerScreen /> },
  ]);
}

function renderDetail(tmdbId = '603', search = '') {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={[`/detail/${tmdbId}${search}`]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function tvFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1408,
    name: 'Mr. Robot',
    overview: 'A cybersecurity engineer is recruited by an anarchist.',
    firstAirDate: '2015-06-24',
    posterPath: '/mrrobot.jpg',
    backdropPath: '/mrrobot-backdrop.jpg',
    voteAverage: 8.5,
    episodeRunTime: [49],
    mediaInfo: null,
    ...overrides,
  };
}

describe('DetailScreen (detail-request spec)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedGetMovieDetails.mockReset();
    mockedGetTvDetails.mockReset();
    mockedRequestMedia.mockReset();
  });

  it('InLibrary: shows "Reproducir" and hides "Pedir"; clicking it navigates to /player/:jellyfinItemId', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-603', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture() as never);

    renderDetail('603');

    const playButton = await screen.findByRole('button', { name: /reproducir/i });
    expect(screen.queryByRole('button', { name: /^pedir$/i })).not.toBeInTheDocument();

    fireEvent.click(playButton);

    expect(await screen.findByText('player-screen:jf-603')).toBeInTheDocument();
  });

  it('InLibrary: shows the green "Audio disponible" line, sourced from the Jellyfin item\'s MediaStreams', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-603', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture() as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-603',
      Name: 'The Matrix',
      MediaStreams: [
        { Type: 'Audio', Language: 'spa' },
        { Type: 'Audio', Language: 'eng' },
        // Same language twice (e.g. a commentary track) must not repeat in the line.
        { Type: 'Audio', Language: 'eng' },
        { Type: 'Subtitle', Language: 'spa' },
      ],
    } as never);

    renderDetail('603');

    expect(await screen.findByText('Audio disponible: Español · Inglés')).toBeInTheDocument();
    expect(mockedGetItem).toHaveBeenCalledWith('user-1', 'jf-603', 'ProviderIds,MediaStreams');
  });

  it('InLibrary: an unknown/undetermined audio language reads as "UND", matching the projector', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-603', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture() as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-603',
      Name: 'The Matrix',
      MediaStreams: [{ Type: 'Audio', Language: 'und' }],
    } as never);

    renderDetail('603');

    expect(await screen.findByText('Audio disponible: UND')).toBeInTheDocument();
  });

  it('Requestable: no "Audio disponible" line (not in the library, no Jellyfin item to read)', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);

    renderDetail('603');

    await screen.findByRole('button', { name: /^pedir$/i });
    expect(screen.queryByText(/Audio disponible/i)).not.toBeInTheDocument();
  });

  it('Requestable: shows an enabled "Pedir" action and no "Reproducir"', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);

    renderDetail('603');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    expect(requestButton).toBeEnabled();
    expect(screen.queryByRole('button', { name: /reproducir/i })).not.toBeInTheDocument();
  });

  it('Requesting: action is disabled and shows the current Jellyseerr status, no duplicate-request affordance', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(
      detailFixture({ mediaInfo: { id: 1, status: 3, mediaType: 'movie' } }) as never,
    );

    renderDetail('603');

    const pendingButton = await screen.findByRole('button', { name: /descargando/i });
    expect(pendingButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^pedir$/i })).not.toBeInTheDocument();
  });

  it('Successful request: status updates from response.media.status, not an assumed local value', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);
    mockedRequestMedia.mockResolvedValue({
      id: 1,
      type: 'movie',
      status: 1,
      media: { id: 1, tmdbId: 603, mediaType: 'movie', status: 2 },
    } as never);

    renderDetail('603');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    fireEvent.click(requestButton);

    expect(await screen.findByRole('button', { name: /pendiente/i })).toBeDisabled();
    expect(mockedRequestMedia).toHaveBeenCalledWith({ mediaType: 'movie', mediaId: 603 });
    expect(screen.queryByRole('button', { name: /^pedir$/i })).not.toBeInTheDocument();
  });

  it('Failed request: status remains Requestable, no optimistic "Requesting" state, error is shown', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);
    mockedRequestMedia.mockRejectedValue(new Error('network down'));

    renderDetail('603');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    fireEvent.click(requestButton);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    const stillRequestButton = screen.getByRole('button', { name: /^pedir$/i });
    expect(stillRequestButton).toBeEnabled();
  });
});

describe('DetailScreen (TV via ?type=tv)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedGetMovieDetails.mockReset();
    mockedGetTvDetails.mockReset();
    mockedRequestMedia.mockReset();
  });

  it('fetches TV details, shows the title, and requests the whole series as tv', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetTvDetails.mockResolvedValue(tvFixture({ mediaInfo: null }) as never);
    mockedRequestMedia.mockResolvedValue({
      id: 1,
      type: 'tv',
      status: 1,
      media: { id: 1, tmdbId: 1408, mediaType: 'tv', status: 2 },
    } as never);

    renderDetail('1408', '?type=tv');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    expect(screen.getByRole('heading', { name: /mr\. robot/i })).toBeInTheDocument();
    // The tv endpoint (not /movie/{id}) served the detail — the ambiguous-id
    // guard: rendering the Mr. Robot title at all proves getTvDetails was used.
    expect(mockedGetTvDetails).toHaveBeenCalledWith(1408);

    fireEvent.click(requestButton);

    expect(await screen.findByRole('button', { name: /pendiente/i })).toBeDisabled();
    expect(mockedRequestMedia).toHaveBeenCalledWith({ mediaType: 'tv', mediaId: 1408 });
  });

  it('InLibrary series renders the two-pane layout, not the single-hero "Reproducir"/"En biblioteca" action', async () => {
    // No episodes distinctly mocked here (`getItems` resolves the same library
    // list for both the LibraryIndex join AND the ParentId episode query) -
    // this is the "not playable yet" edge: two-pane still renders (TEMPORADAS +
    // Eliminar), just with an empty right pane, instead of a lone "Reproducir"
    // that would 500 against Jellyfin's whole-series PlaybackInfo.
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-1408', Name: 'Mr. Robot', Type: 'Series', ProviderIds: { Tmdb: '1408' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetTvDetails.mockResolvedValue(tvFixture() as never);

    renderDetail('1408', '?type=tv');

    expect(await screen.findByRole('heading', { name: /mr\. robot/i })).toBeInTheDocument();
    expect(screen.getByText('TEMPORADAS')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^eliminar$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reproducir$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /en biblioteca/i })).not.toBeInTheDocument();
  });

  it('two-pane: renders seasons + episodes merged from Jellyfin, with season switching', async () => {
    mockedGetItems.mockImplementation(async (_userId, params) => {
      if (params?.parentId === 'jf-1408') {
        return {
          Items: [
            { Id: 'ep-1', Name: 'Episode One', IndexNumber: 1, ParentIndexNumber: 1, SeriesId: 'jf-1408' },
            { Id: 'ep-2', Name: 'Episode Two', IndexNumber: 2, ParentIndexNumber: 1, SeriesId: 'jf-1408' },
            { Id: 'ep-3', Name: 'Episode Three', IndexNumber: 1, ParentIndexNumber: 2, SeriesId: 'jf-1408' },
          ],
          TotalRecordCount: 3,
          StartIndex: 0,
        };
      }
      return {
        Items: [{ Id: 'jf-1408', Name: 'Mr. Robot', Type: 'Series', ProviderIds: { Tmdb: '1408' } }],
        TotalRecordCount: 1,
        StartIndex: 0,
      };
    });
    mockedGetTvDetails.mockResolvedValue(tvFixture() as never);

    renderDetail('1408', '?type=tv');

    expect(await screen.findByRole('heading', { name: 'Temporada 1' })).toBeInTheDocument();
    expect(screen.getByText('S1·E1 — Episode One')).toBeInTheDocument();
    expect(screen.getByText('S1·E2 — Episode Two')).toBeInTheDocument();
    expect(screen.getAllByText('Disponible')).toHaveLength(2);
    expect(screen.queryByText('S2·E1 — Episode Three')).not.toBeInTheDocument();
    // The in-poster play button is present - at least one episode is Available.
    expect(screen.getByRole('button', { name: /^reproducir$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /temporada 2/i }));

    expect(await screen.findByRole('heading', { name: 'Temporada 2' })).toBeInTheDocument();
    expect(screen.getByText('S2·E1 — Episode Three')).toBeInTheDocument();
    expect(screen.queryByText('S1·E1 — Episode One')).not.toBeInTheDocument();
  });

  it('two-pane renders for a series in the Jellyfin library even when Jellyseerr says "partially available" (status 4)', async () => {
    // Regression for the live bug: the movies-only library row (useLibraryRow)
    // never resolves a series to InLibrary, so the title-level status here is
    // Requesting (status 4 -> "Parcialmente disponible"). The two-pane MUST
    // still render because an independent Series fetch resolves the Jellyfin
    // series id. `/detail/62560?type=tv` (Mr. Robot) is the exact live repro.
    mockedGetItems.mockImplementation(async (_userId, params) => {
      if (params?.includeItemTypes === 'Series') {
        return {
          Items: [{ Id: 'jf-62560', Name: 'Mr. Robot', Type: 'Series', ProviderIds: { Tmdb: '62560' } }],
          TotalRecordCount: 1,
          StartIndex: 0,
        };
      }
      if (params?.parentId === 'jf-62560') {
        return {
          Items: [{ Id: 'ep-1', Name: 'eps1.0_hellofriend.mov', IndexNumber: 1, ParentIndexNumber: 1, SeriesId: 'jf-62560' }],
          TotalRecordCount: 1,
          StartIndex: 0,
        };
      }
      // The movies-only library row (useLibraryRow) sees no series at all.
      return EMPTY_LIBRARY;
    });
    mockedGetTvDetails.mockResolvedValue(
      tvFixture({ id: 62560, mediaInfo: { id: 9, tmdbId: 62560, mediaType: 'tv', status: 4 } }) as never,
    );

    renderDetail('62560', '?type=tv');

    // Episode browser renders (two-pane), NOT the single-pane movie layout.
    expect(await screen.findByText('TEMPORADAS')).toBeInTheDocument();
    expect(screen.getByText('S1·E1 — eps1.0_hellofriend.mov')).toBeInTheDocument();
    // The would-be single-pane status pill "Parcialmente disponible" is not the
    // whole layout - the two-pane took over.
    expect(screen.getByRole('heading', { name: /mr\. robot/i })).toBeInTheDocument();
  });

  it('two-pane: a fully InLibrary series still shows "Eliminar", not "Cancelar"', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-1408', Name: 'Mr. Robot', Type: 'Series', ProviderIds: { Tmdb: '1408' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetTvDetails.mockResolvedValue(tvFixture() as never);

    renderDetail('1408', '?type=tv');

    expect(await screen.findByRole('button', { name: /^eliminar$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancelar$/i })).not.toBeInTheDocument();
  });

  it('two-pane: a Sonarr 401/outage degrades to Jellyfin-only episodes, no crash', async () => {
    mockedGetItems.mockImplementation(async (_userId, params) => {
      if (params?.parentId === 'jf-1408') {
        return {
          Items: [{ Id: 'ep-1', Name: 'Episode One', IndexNumber: 1, ParentIndexNumber: 1, SeriesId: 'jf-1408' }],
          TotalRecordCount: 1,
          StartIndex: 0,
        };
      }
      return {
        Items: [{ Id: 'jf-1408', Name: 'Mr. Robot', Type: 'Series', ProviderIds: { Tmdb: '1408' } }],
        TotalRecordCount: 1,
        StartIndex: 0,
      };
    });
    mockedGetTvDetails.mockResolvedValue(tvFixture() as never);
    mockedGetSonarrSeries.mockRejectedValue(new Error('401 Unauthorized'));

    renderDetail('1408', '?type=tv');

    expect(await screen.findByText('S1·E1 — Episode One')).toBeInTheDocument();
    expect(screen.getByText('Disponible')).toBeInTheDocument();
    // No error surfaced to the user - degradation is silent, per the task brief.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('DetailScreen (delete/cancel actions)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedGetMovieDetails.mockReset();
    mockedGetTvDetails.mockReset();
    mockedRequestMedia.mockReset();
    mockedGetRequests.mockReset();
    mockedDeleteRequest.mockReset();
    mockedGetRadarrMovies.mockReset();
    mockedDeleteRadarrMovie.mockReset();
    mockedGetSonarrSeries.mockReset();
    mockedDeleteSonarrSeries.mockReset();
  });

  function TestHomeScreen() {
    return <p>home-screen</p>;
  }

  function TestRouteTreeWithHome() {
    return useRoutes([
      { path: '/', element: <TestHomeScreen /> },
      { path: '/detail/:id', element: <DetailScreen /> },
      { path: '/player/:id', element: <TestPlayerScreen /> },
    ]);
  }

  function renderDetailWithHistory(tmdbId: string, search = '') {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    render(
      <MemoryRouter initialEntries={['/', `/detail/${tmdbId}${search}`]} initialIndex={1}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TestRouteTreeWithHome />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('Eliminar: opens a confirm overlay, and on confirm resolves the Radarr movie and deletes it (deleteFiles=true), then navigates back', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-603', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture() as never);
    mockedGetRadarrMovies.mockResolvedValue([
      { id: 55, tmdbId: 603, monitored: true, hasFile: true, title: 'The Matrix' },
    ] as never);
    mockedDeleteRadarrMovie.mockResolvedValue(undefined);

    renderDetailWithHistory('603');

    const deleteButton = await screen.findByRole('button', { name: /^eliminar$/i });
    fireEvent.click(deleteButton);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/eliminar «the matrix»/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /^eliminar$/i }));

    await waitFor(() => expect(mockedDeleteRadarrMovie).toHaveBeenCalledWith(55, true));
    expect(await screen.findByText('home-screen')).toBeInTheDocument();
  });

  it('Eliminar: a failed delete shows an inline error, no crash', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-603', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture() as never);
    // 401-gated in the real dev env (no Radarr API key) - modeled here as an
    // empty movie list, so the tmdbId never resolves to a Radarr identity.
    mockedGetRadarrMovies.mockResolvedValue([]);

    renderDetail('603');

    fireEvent.click(await screen.findByRole('button', { name: /^eliminar$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^eliminar$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo eliminar/i);
    expect(mockedDeleteRadarrMovie).not.toHaveBeenCalled();
  });

  it('Cancelar: opens a confirm overlay with "No, seguir", and on confirm calls the shared useCancelDownload, then navigates back', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(
      detailFixture({ mediaInfo: { id: 1, status: 3, mediaType: 'movie' } }) as never,
    );
    mockedGetRequests.mockResolvedValue({
      pageInfo: null,
      results: [{ id: 77, type: 'movie', status: 3, media: { id: 1, tmdbId: 603, mediaType: 'movie', status: 3 } }],
    } as never);
    mockedDeleteRequest.mockResolvedValue(undefined);

    renderDetailWithHistory('603');

    const cancelButton = await screen.findByRole('button', { name: /^cancelar$/i });
    fireEvent.click(cancelButton);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /no, seguir/i })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /sí, cancelar/i }));

    await waitFor(() => expect(mockedDeleteRequest).toHaveBeenCalledWith(77));
    expect(await screen.findByText('home-screen')).toBeInTheDocument();
  });

  it('Cancelar: dismissing with "No, seguir" does not call useCancelDownload', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(
      detailFixture({ mediaInfo: { id: 1, status: 3, mediaType: 'movie' } }) as never,
    );

    renderDetail('603');

    fireEvent.click(await screen.findByRole('button', { name: /^cancelar$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /no, seguir/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockedDeleteRequest).not.toHaveBeenCalled();
  });

  it('Series two-pane, Requesting (status 4, "Parcialmente disponible"): still shows "Eliminar" not "Cancelar" (ground truth: an in-library series is InLibrary even while downloading)', async () => {
    // The movies-only library row sees no series, so the title-level status is
    // Requesting (status 4), while the independent Series fetch resolves the
    // Jellyfin series id (two-pane renders). Per docs/projector-walkthrough.md
    // §19 (Hellsing "Descargando · 90%" -> "Eliminar"), a series that has any
    // Jellyfin episodes is InLibrary -> Eliminar, NOT Cancelar - even mid
    // download. Only a not-yet-downloaded (no-Jellyfin-episodes) series keeps
    // the single-hero Requesting -> Cancelar path.
    mockedGetItems.mockImplementation(async (_userId, params) => {
      if (params?.includeItemTypes === 'Series') {
        return {
          Items: [{ Id: 'jf-62560', Name: 'Mr. Robot', Type: 'Series', ProviderIds: { Tmdb: '62560' } }],
          TotalRecordCount: 1,
          StartIndex: 0,
        };
      }
      if (params?.parentId === 'jf-62560') {
        return {
          Items: [
            { Id: 'ep-1', Name: 'eps1.0_hellofriend.mov', IndexNumber: 1, ParentIndexNumber: 1, SeriesId: 'jf-62560' },
          ],
          TotalRecordCount: 1,
          StartIndex: 0,
        };
      }
      return EMPTY_LIBRARY;
    });
    mockedGetTvDetails.mockResolvedValue(
      tvFixture({ id: 62560, mediaInfo: { id: 9, tmdbId: 62560, mediaType: 'tv', status: 4 } }) as never,
    );

    renderDetailWithHistory('62560', '?type=tv');

    // Ground truth: Eliminar is offered; Cancelar is NOT in the two-pane.
    expect(await screen.findByRole('button', { name: /^eliminar$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancelar$/i })).not.toBeInTheDocument();
  });
});
