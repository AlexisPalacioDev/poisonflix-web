import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { NORMAL_CATEGORIES } from '../../lib/domain/categories';
import { clearSession, setSession } from '../../lib/session/store';
import { getItems, getResumeItems } from '../../api/jellyfin';
import { discoverMovies, discoverTrending, getMovieDetails, getRequests, getTvDetails } from '../../api/jellyseerr';
import { getRadarrMovies, getRadarrQueue, getSonarrQueue, getSonarrSeries } from '../../api/arr';

vi.mock('../../api/jellyfin', () => ({
  getItems: vi.fn(),
  getResumeItems: vi.fn(),
  // No adult library by default, so the library row's adult-exclusion filter
  // is a no-op and every existing assertion holds.
  getUserViews: vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
}));
vi.mock('../../api/jellyseerr', () => ({
  discoverTrending: vi.fn(),
  discoverMovies: vi.fn(),
  getRequests: vi.fn(),
  getMovieDetails: vi.fn(),
  getTvDetails: vi.fn(),
}));
vi.mock('../../api/arr', () => ({
  getRadarrMovies: vi.fn(),
  getRadarrQueue: vi.fn(),
  getSonarrQueue: vi.fn(),
  getSonarrSeries: vi.fn(),
}));
// "Mi lista" row: empty by default so it renders nothing and every existing
// Home assertion holds unchanged.
vi.mock('../../api/bff', () => ({
  getWatchlist: vi.fn().mockResolvedValue([]),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
}));

const mockedGetItems = vi.mocked(getItems);
const mockedDiscoverTrending = vi.mocked(discoverTrending);
const mockedDiscoverMovies = vi.mocked(discoverMovies);
// New rows' data sources - defaulted to empty/idle in `beforeEach` below so
// every pre-existing test in this file renders the two new rows as hidden
// (no items) without needing its own mocking, per their "nothing when
// empty" contract (ContinueWatchingRow.tsx, DownloadingRow.tsx).
const mockedGetResumeItems = vi.mocked(getResumeItems);
const mockedGetRequests = vi.mocked(getRequests);
const mockedGetMovieDetails = vi.mocked(getMovieDetails);
const mockedGetTvDetails = vi.mocked(getTvDetails);
const mockedGetRadarrMovies = vi.mocked(getRadarrMovies);
const mockedGetRadarrQueue = vi.mocked(getRadarrQueue);
const mockedGetSonarrQueue = vi.mocked(getSonarrQueue);
const mockedGetSonarrSeries = vi.mocked(getSonarrSeries);

beforeEach(() => {
  mockedGetResumeItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
  mockedGetRequests.mockResolvedValue({ results: [] });
  mockedGetMovieDetails.mockResolvedValue(undefined as never);
  mockedGetTvDetails.mockResolvedValue(undefined as never);
  mockedGetRadarrMovies.mockResolvedValue([]);
  mockedGetRadarrQueue.mockResolvedValue({ records: [] });
  mockedGetSonarrQueue.mockResolvedValue({ records: [] });
  mockedGetSonarrSeries.mockResolvedValue([]);
});

// Empty-but-valid envelope so the 10 genre rows' discover half settles
// without contributing extra titles - tests below only care about the
// Library/Trending row behavior plus the genre rows' own region/title wiring.
const EMPTY_DISCOVER_FIXTURE = { page: 1, totalPages: 0, totalResults: 0, results: [] };

const LIBRARY_FIXTURE = {
  Items: [{ Id: 'jf-1', Name: 'The Matrix', ProviderIds: { Tmdb: '603' }, ImageTags: null }],
  TotalRecordCount: 1,
  StartIndex: 0,
};

const TRENDING_FIXTURE = {
  page: 1,
  totalPages: 1,
  totalResults: 1,
  results: [
    {
      id: 100,
      mediaType: 'movie',
      title: 'Trending Movie',
      name: null,
      releaseDate: '2024-01-01',
      firstAirDate: null,
      overview: null,
      posterPath: '/poster.jpg',
      backdropPath: null,
      voteAverage: 8,
      adult: false,
      genreIds: [],
      mediaInfo: null,
    },
  ],
};

// The 10 genre rows call the same mocked `getItems` as the Library row, so a
// blanket `mockResolvedValue(LIBRARY_FIXTURE)` would make every genre row
// ALSO resolve "The Matrix" - colliding with the Library row's own instance
// under `screen.findByText`. Scoping by the (only the Library row omits)
// `genres` param keeps each row's fixture where it belongs, same as a real
// Jellyfin server would.
function mockGetItemsScoped(libraryFixture: unknown) {
  mockedGetItems.mockImplementation(async (_userId, params) => {
    // Genre rows (`genres`) and the "Mis favoritos" row (`filters: IsFavorite`)
    // both share this mocked getItems; only the Library row is unscoped. Return
    // empty for the scoped calls so LIBRARY_FIXTURE's title renders exactly once
    // (a real server has no favorites by default here).
    if (params?.genres || params?.filters) return { Items: [], TotalRecordCount: 0, StartIndex: 0 } as never;
    return libraryFixture as never;
  });
}

function renderHome() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <HomeScreen />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('HomeScreen - row isolation (home spec)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedDiscoverTrending.mockReset();
    mockedDiscoverMovies.mockReset();
    mockedGetResumeItems.mockReset();
    mockedGetRequests.mockReset();
  });

  it('renders exactly the Library and Trending row titles (fixed MVP row set)', async () => {
    mockGetItemsScoped(LIBRARY_FIXTURE);
    mockedDiscoverTrending.mockResolvedValue(TRENDING_FIXTURE as never);
    mockedDiscoverMovies.mockResolvedValue(EMPTY_DISCOVER_FIXTURE as never);

    renderHome();

    expect(await screen.findByText('The Matrix')).toBeInTheDocument();
    expect(await screen.findByText('Trending Movie')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tu biblioteca' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tendencias' })).toBeInTheDocument();
  });

  it('Trending fails: Library still renders its items normally (row isolation)', async () => {
    mockGetItemsScoped(LIBRARY_FIXTURE);
    mockedDiscoverTrending.mockRejectedValue(new Error('jellyseerr down'));
    mockedDiscoverMovies.mockResolvedValue(EMPTY_DISCOVER_FIXTURE as never);

    renderHome();

    // Library row unaffected by the Trending failure.
    expect(await screen.findByText('The Matrix')).toBeInTheDocument();

    // Trending row shows its own row-scoped error, not a screen-wide blank.
    const trendingRow = screen.getByRole('region', { name: 'Tendencias' });
    expect(trendingRow).toHaveTextContent(/no se pudo cargar/i);
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });

  it('Library fails: Trending still renders its items normally (row isolation)', async () => {
    mockedGetItems.mockRejectedValue(new Error('jellyfin down'));
    mockedDiscoverTrending.mockResolvedValue(TRENDING_FIXTURE as never);
    mockedDiscoverMovies.mockResolvedValue(EMPTY_DISCOVER_FIXTURE as never);

    renderHome();

    // Trending row unaffected by the Library failure.
    expect(await screen.findByText('Trending Movie')).toBeInTheDocument();

    // Library row shows its own row-scoped error, not a screen-wide blank.
    const libraryRow = screen.getByRole('region', { name: 'Tu biblioteca' });
    expect(libraryRow).toHaveTextContent(/no se pudo cargar/i);
    expect(within(libraryRow).getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });
});

describe('HomeScreen - genre/category rows (projector-feature-map.md §3)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedDiscoverTrending.mockReset();
    mockedDiscoverMovies.mockReset();
    mockedGetResumeItems.mockReset();
    mockedGetRequests.mockReset();
  });

  it('renders all 10 genre rows, in catalog order, each a landmark region by its label', async () => {
    mockGetItemsScoped(LIBRARY_FIXTURE);
    mockedDiscoverTrending.mockResolvedValue(TRENDING_FIXTURE as never);
    mockedDiscoverMovies.mockResolvedValue(EMPTY_DISCOVER_FIXTURE as never);

    renderHome();

    expect(await screen.findByText('The Matrix')).toBeInTheDocument();

    for (const category of NORMAL_CATEGORIES) {
      expect(screen.getByRole('region', { name: category.label })).toBeInTheDocument();
    }

    // Every genre row queries its own Jellyfin genre + TMDB discover genre id -
    // wait for the last category's calls to have landed before asserting,
    // since all 10 rows' queries settle asynchronously in parallel.
    const lastCategory = NORMAL_CATEGORIES[NORMAL_CATEGORIES.length - 1];
    await waitFor(() =>
      expect(mockedDiscoverMovies).toHaveBeenCalledWith({ genre: lastCategory.tmdbGenreId }),
    );

    for (const category of NORMAL_CATEGORIES) {
      expect(mockedGetItems).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ genres: category.jellyfinGenre }),
      );
      expect(mockedDiscoverMovies).toHaveBeenCalledWith({ genre: category.tmdbGenreId });
    }
  });

  it('shows a PEDIR badge only on a genre row item that is not in the library', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedDiscoverTrending.mockResolvedValue(TRENDING_FIXTURE as never);
    mockedDiscoverMovies.mockImplementation(async ({ genre }) => {
      if (genre !== NORMAL_CATEGORIES[0].tmdbGenreId) return EMPTY_DISCOVER_FIXTURE as never;
      return {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        results: [
          {
            id: 500,
            mediaType: 'movie',
            title: 'Unowned Action Movie',
            name: null,
            releaseDate: '2023-01-01',
            firstAirDate: null,
            overview: null,
            posterPath: '/action.jpg',
            backdropPath: null,
            voteAverage: 7,
            adult: false,
            genreIds: [],
            mediaInfo: null,
          },
        ],
      } as never;
    });

    renderHome();

    const actionRow = screen.getByRole('region', { name: NORMAL_CATEGORIES[0].label });
    expect(await within(actionRow).findByText('Unowned Action Movie')).toBeInTheDocument();
    expect(actionRow).toHaveTextContent('PEDIR');
  });
});
