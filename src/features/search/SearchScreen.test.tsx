import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchScreen } from './SearchScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getItems } from '../../api/jellyfin';
import { discoverTrending, getMovieDetails, getTvDetails, search } from '../../api/jellyseerr';
import type { JellyseerrSearchResult } from '../../api/schemas/jellyseerr';

vi.mock('../../api/jellyfin', () => ({
  getItems: vi.fn(),
  getItem: vi.fn(),
  getUserViews: vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
}));
vi.mock('../../api/jellyseerr', () => ({
  search: vi.fn(),
  discoverTrending: vi.fn(),
  getMovieDetails: vi.fn(),
  getTvDetails: vi.fn(),
}));

const mockedGetItems = vi.mocked(getItems);
const mockedGetItem = vi.mocked(getItem);
const mockedSearch = vi.mocked(search);
const mockedGetMovieDetails = vi.mocked(getMovieDetails);
const mockedGetTvDetails = vi.mocked(getTvDetails);
const mockedDiscoverTrending = vi.mocked(discoverTrending);

const EMPTY_RESPONSE = { page: 1, totalPages: 1, totalResults: 0, results: [] };

const LIBRARY_FIXTURE = {
  Items: [{ Id: 'jf-1', Name: 'Breaking Bad', ProviderIds: { Tmdb: '1396' }, ImageTags: null }],
  TotalRecordCount: 1,
  StartIndex: 0,
};

function resultFixture(overrides: Partial<JellyseerrSearchResult> & { id: number }): JellyseerrSearchResult {
  return {
    mediaType: 'tv',
    title: null,
    name: null,
    releaseDate: null,
    firstAirDate: '2008-01-20',
    overview: 'A chemistry teacher turns to making meth.',
    posterPath: '/poster.jpg',
    backdropPath: null,
    voteAverage: 8.9,
    adult: false,
    genreIds: [],
    mediaInfo: null,
    ...overrides,
  };
}

// Generic tv-detail fixture for tests that don't assert on the fetched
// detail's own content - just that `useTitleDetail`'s query resolves cleanly
// instead of throwing inside `normalizeTv`/`normalizeMovie` (which would
// happen if the mock stayed `undefined`).
function tvDetailsFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1396,
    name: 'Breaking Bad',
    overview: 'A chemistry teacher turns to making meth.',
    firstAirDate: '2008-01-20',
    posterPath: '/poster.jpg',
    backdropPath: null,
    voteAverage: 8.9,
    episodeRunTime: [47],
    mediaInfo: null,
    ...overrides,
  };
}

function renderSearch() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/search']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <SearchScreen />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SearchScreen (search spec)', () => {
  // The idle (empty-query) carousel now falls back to Trending, so every
  // render resolves this query. Default it to empty so tests that are not
  // about suggestions keep their original empty-carousel assumptions; a
  // queryFn resolving `undefined` would make react-query error the row.
  beforeEach(() => {
    mockedDiscoverTrending.mockResolvedValue(EMPTY_RESPONSE as never);
  });

  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedGetItem.mockReset();
    mockedSearch.mockReset();
    mockedGetMovieDetails.mockReset();
    mockedGetTvDetails.mockReset();
    mockedDiscoverTrending.mockReset();
  });

  it('does not issue a request below the 2-char minimum, and shows a non-error empty state', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    renderSearch();

    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'a' } });

    // Give the 350ms debounce window (and then some) time to elapse. The
    // debounced value settling triggers a state update, so this must be
    // wrapped in `act` even though nothing else drives it directly.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    expect(mockedSearch).not.toHaveBeenCalled();
    // Trending is the idle fallback; with it empty the row shows the
    // suggestions empty state, still non-error.
    expect(await screen.findByText(/no hay sugerencias/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('debounces, dedupes duplicate ids, and joins InLibrary/Requestable status onto results', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    mockedGetTvDetails.mockResolvedValue(tvDetailsFixture() as never);
    mockedSearch.mockResolvedValue({
      page: 1,
      totalPages: 1,
      totalResults: 2,
      results: [
        resultFixture({ id: 1396, name: 'Breaking Bad', mediaType: 'tv' }),
        // Duplicate TMDB id - must collapse to a single carousel entry.
        resultFixture({ id: 1396, name: 'Breaking Bad', mediaType: 'tv' }),
        resultFixture({ id: 42, name: 'Fringe', mediaType: 'tv', mediaInfo: null }),
      ],
    } as never);

    renderSearch();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'breaking' } });

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('breaking'), { timeout: 2000 });

    // Dedup: only ONE poster button for the duplicated TMDB id.
    expect(await screen.findAllByRole('button', { name: /breaking bad/i })).toHaveLength(1);

    // Library-status badges, resolved via LibraryIndex (design.md §4.4).
    // "En biblioteca" appears twice: once on the carousel poster, once on the
    // auto-selected big preview (both render the same Breaking Bad result).
    expect(screen.getAllByText('En biblioteca')).toHaveLength(2);
    expect(screen.getByText('Pedir')).toBeInTheDocument(); // Fringe has no library/request match.

    // Big preview auto-selects the first result.
    expect(screen.getByRole('heading', { name: 'Breaking Bad' })).toBeInTheDocument();
  });

  it('selecting a different carousel result updates the big preview (search spec)', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    mockedGetTvDetails.mockImplementation(
      async (tmdbId: number) =>
        tvDetailsFixture(
          tmdbId === 42 ? { id: 42, name: 'Fringe', firstAirDate: '2008-08-25' } : undefined,
        ) as never,
    );
    mockedSearch.mockResolvedValue({
      page: 1,
      totalPages: 1,
      totalResults: 2,
      results: [
        resultFixture({ id: 1396, name: 'Breaking Bad', mediaType: 'tv' }),
        resultFixture({ id: 42, name: 'Fringe', mediaType: 'tv' }),
      ],
    } as never);

    renderSearch();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'br' } });

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('br'), { timeout: 2000 });
    expect(await screen.findByRole('heading', { name: 'Breaking Bad' })).toBeInTheDocument();

    fireEvent.focus(screen.getByRole('button', { name: /fringe/i }));

    expect(await screen.findByRole('heading', { name: 'Fringe' })).toBeInTheDocument();
  });

  it('selecting a result fetches its full detail and the preview shows the fetched overview (feature-map §5)', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [],
      TotalRecordCount: 0,
      StartIndex: 0,
    } as never);
    mockedSearch.mockResolvedValue({
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        resultFixture({
          id: 550,
          mediaType: 'movie',
          title: 'Fight Club',
          overview: 'Short list-shaped overview.',
        }),
      ],
    } as never);
    mockedGetMovieDetails.mockResolvedValue({
      id: 550,
      title: 'Fight Club',
      overview: 'Full rich overview fetched from the movie detail endpoint.',
      releaseDate: '1999-10-15',
      posterPath: '/poster.jpg',
      backdropPath: null,
      voteAverage: 8.4,
      runtime: 139,
      mediaInfo: null,
    } as never);

    renderSearch();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'fight' } });

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('fight'), { timeout: 2000 });
    expect(await screen.findByRole('heading', { name: 'Fight Club' })).toBeInTheDocument();

    // The selected result's full detail was fetched (not every carousel item -
    // there's only one here, but the point is it's the SELECTED one)...
    await waitFor(() => expect(mockedGetMovieDetails).toHaveBeenCalledWith(550));

    // ...and the preview shows the richer detail overview, not the search
    // result's own short one, once the fetch settles.
    expect(
      await screen.findByText('Full rich overview fetched from the movie detail endpoint.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Short list-shaped overview.')).not.toBeInTheDocument();
  });

  it('shows "Audio disponible" for an in-library selected title, reusing MediaStreams like DetailScreen', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-550', Name: 'Fight Club', ProviderIds: { Tmdb: '550' }, ImageTags: null }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedSearch.mockResolvedValue({
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [resultFixture({ id: 550, mediaType: 'movie', title: 'Fight Club' })],
    } as never);
    mockedGetMovieDetails.mockResolvedValue({
      id: 550,
      title: 'Fight Club',
      overview: 'Full rich overview.',
      releaseDate: '1999-10-15',
      posterPath: '/poster.jpg',
      backdropPath: null,
      voteAverage: 8.4,
      runtime: 139,
      mediaInfo: null,
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-550',
      Name: 'Fight Club',
      ProviderIds: { Tmdb: '550' },
      MediaStreams: [
        { Type: 'Audio', Language: 'eng' },
        { Type: 'Audio', Language: 'spa' },
      ],
      ImageTags: null,
    } as never);

    renderSearch();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'fight' } });

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('fight'), { timeout: 2000 });
    expect(await screen.findByRole('heading', { name: 'Fight Club' })).toBeInTheDocument();

    expect(mockedGetItem).toHaveBeenCalledWith('user-1', 'jf-550', 'ProviderIds,MediaStreams');
    expect(await screen.findByText('Audio disponible: Inglés · Español')).toBeInTheDocument();
  });

  it('empty query shows trending suggestions instead of an idle empty state', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    mockedGetTvDetails.mockResolvedValue(tvDetailsFixture() as never);
    mockedSearch.mockClear();
    mockedDiscoverTrending.mockResolvedValue({
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [resultFixture({ id: 1396, name: 'Breaking Bad', mediaType: 'tv' })],
    } as never);

    renderSearch();

    // Nothing typed -> no Jellyseerr *search* fires...
    expect(mockedSearch).not.toHaveBeenCalled();

    // ...but the carousel is no longer a dead end: it falls back to Home's
    // Trending row (same query key -> same react-query cache entry, so
    // arriving from Home costs no extra request), badge-joined against the
    // library exactly like real search results.
    expect(await screen.findByRole('heading', { name: 'Sugerencias' })).toBeInTheDocument();
    expect(await screen.findAllByRole('button', { name: /breaking bad/i })).toHaveLength(1);
    expect((await screen.findAllByText('En biblioteca')).length).toBeGreaterThan(0);

    // And the big preview auto-selects the first suggestion instead of
    // rendering its placeholder.
    expect(await screen.findByRole('heading', { name: 'Breaking Bad' })).toBeInTheDocument();
    expect(
      screen.queryByText('Buscá y elegí un título para ver el detalle.'),
    ).not.toBeInTheDocument();
  });

  it('clears the big preview on a settled empty-results query (walkthrough §21 deliberate deviation)', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    mockedGetTvDetails.mockResolvedValue(tvDetailsFixture() as never);
    mockedSearch
      .mockResolvedValueOnce({
        page: 1,
        totalPages: 1,
        totalResults: 1,
        results: [resultFixture({ id: 1396, name: 'Breaking Bad', mediaType: 'tv' })],
      } as never)
      .mockResolvedValueOnce({ page: 1, totalPages: 1, totalResults: 0, results: [] } as never);

    renderSearch();
    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'breaking' } });

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('breaking'), { timeout: 2000 });
    expect(await screen.findByRole('heading', { name: 'Breaking Bad' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: /buscar/i }), { target: { value: 'zzzzxxnoexiste' } });

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('zzzzxxnoexiste'), { timeout: 2000 });
    expect(await screen.findByText(/Sin resultados para "zzzzxxnoexiste"/)).toBeInTheDocument();

    // Deliberate web decision (walkthrough §21 flags the native app as
    // NOT clearing the preview on empty results - a bug/inconsistency there):
    // the preview resets to its empty state instead of keeping the stale
    // "Breaking Bad" preview around.
    expect(screen.queryByRole('heading', { name: 'Breaking Bad' })).not.toBeInTheDocument();
    expect(screen.getByText('Buscá y elegí un título para ver el detalle.')).toBeInTheDocument();
  });
});
