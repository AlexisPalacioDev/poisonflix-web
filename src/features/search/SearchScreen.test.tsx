import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchScreen } from './SearchScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItems } from '../../api/jellyfin';
import { search } from '../../api/jellyseerr';
import type { JellyseerrSearchResult } from '../../api/schemas/jellyseerr';

vi.mock('../../api/jellyfin', () => ({ getItems: vi.fn() }));
vi.mock('../../api/jellyseerr', () => ({ search: vi.fn() }));

const mockedGetItems = vi.mocked(getItems);
const mockedSearch = vi.mocked(search);

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
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedSearch.mockReset();
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
    expect(screen.getByText(/al menos 2 caracteres/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('debounces, dedupes duplicate ids, and joins InLibrary/Requestable status onto results', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
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
});
