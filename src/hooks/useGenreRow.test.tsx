import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getItems } from '../api/jellyfin';
import { discoverMovies } from '../api/jellyseerr';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import type { JellyseerrSearchResult } from '../api/schemas/jellyseerr';
import { AuthProvider } from '../auth/AuthContext';
import { NORMAL_CATEGORIES } from '../lib/domain/categories';
import { clearSession, setSession } from '../lib/session/store';
import { mergeGenreRow, useGenreRow } from './useGenreRow';

vi.mock('../api/jellyfin', () => ({ getItems: vi.fn() }));
vi.mock('../api/jellyseerr', () => ({ discoverMovies: vi.fn() }));

const mockedGetItems = vi.mocked(getItems);
const mockedDiscoverMovies = vi.mocked(discoverMovies);

function libraryItem(overrides: Partial<JellyfinItem> & { Id: string; Name: string }): JellyfinItem {
  return overrides as JellyfinItem;
}

function discoverResult(
  overrides: Partial<JellyseerrSearchResult> & { id: number },
): JellyseerrSearchResult {
  return {
    mediaType: 'movie',
    title: null,
    name: null,
    releaseDate: null,
    firstAirDate: null,
    overview: null,
    posterPath: null,
    backdropPath: null,
    voteAverage: null,
    adult: false,
    genreIds: [],
    mediaInfo: null,
    ...overrides,
  };
}

describe('mergeGenreRow (pure merge/dedup/status logic)', () => {
  it('a discover item already in the library is dropped in favor of the library entry', () => {
    const library = [libraryItem({ Id: 'jf-1', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } })];
    const discover = [discoverResult({ id: 603, title: 'The Matrix' })];

    const merged = mergeGenreRow(library, discover);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: '603',
      status: { kind: 'InLibrary', jellyfinItemId: 'jf-1', matchedByFallback: false },
    });
  });

  it('drops adult discover results entirely', () => {
    const discover = [discoverResult({ id: 1, title: 'Adult Title', adult: true })];

    const merged = mergeGenreRow([], discover);

    expect(merged).toEqual([]);
  });

  it('flags a discover item with no library/request match as Requestable', () => {
    const discover = [discoverResult({ id: 27205, title: 'Inception' })];

    const merged = mergeGenreRow([], discover);

    expect(merged).toEqual([
      { id: '27205', title: 'Inception', status: { kind: 'Requestable' }, posterPath: null },
    ]);
  });

  it('library items win an id collision over a duplicate discover entry (library-wins dedup)', () => {
    const library = [libraryItem({ Id: 'jf-9', Name: 'Dup', ProviderIds: { Tmdb: '9' } })];
    // Same tmdb id 9 sneaking in a second time via discover, bypassing the
    // InLibrary short-circuit (defensive belt-and-suspenders case).
    const discover = [discoverResult({ id: 9, title: 'Dup' })];

    const merged = mergeGenreRow(library, discover);

    expect(merged).toHaveLength(1);
    expect(merged[0].status.kind).toBe('InLibrary');
  });

  it('keeps unrelated library and discover items independently', () => {
    const library = [libraryItem({ Id: 'jf-1', Name: 'Library Only', ProviderIds: { Tmdb: '1' } })];
    const discover = [discoverResult({ id: 2, title: 'Discover Only' })];

    const merged = mergeGenreRow(library, discover);

    expect(merged.map((item) => item.id).sort()).toEqual(['1', '2']);
  });
});

const category = NORMAL_CATEGORIES[0];

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe('useGenreRow (wired hook: fetches + merges both sources)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedDiscoverMovies.mockReset();
  });

  it('merges library + discover results, calling both APIs with the category genre', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({
      Items: [libraryItem({ Id: 'jf-1', Name: 'Owned Title', ProviderIds: { Tmdb: '1' } })],
      TotalRecordCount: 1,
      StartIndex: 0,
    });
    mockedDiscoverMovies.mockResolvedValue({
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [discoverResult({ id: 2, title: 'Requestable Title' })],
    });

    const { result } = renderHook(() => useGenreRow(category), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      {
        id: '1',
        title: 'Owned Title',
        status: { kind: 'InLibrary', jellyfinItemId: 'jf-1', matchedByFallback: false },
        jellyfinItem: expect.objectContaining({ Id: 'jf-1' }),
      },
      { id: '2', title: 'Requestable Title', status: { kind: 'Requestable' }, posterPath: null },
    ]);

    expect(mockedGetItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ genres: category.jellyfinGenre }),
    );
    expect(mockedDiscoverMovies).toHaveBeenCalledWith({ genre: category.tmdbGenreId });
  });

  it('a failed discover call never blanks the library items (row isolation)', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({
      Items: [libraryItem({ Id: 'jf-1', Name: 'Owned Title', ProviderIds: { Tmdb: '1' } })],
      TotalRecordCount: 1,
      StartIndex: 0,
    });
    mockedDiscoverMovies.mockRejectedValue(new Error('jellyseerr down'));

    const { result } = renderHook(() => useGenreRow(category), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      {
        id: '1',
        title: 'Owned Title',
        status: { kind: 'InLibrary', jellyfinItemId: 'jf-1', matchedByFallback: false },
        jellyfinItem: expect.objectContaining({ Id: 'jf-1' }),
      },
    ]);
  });

  it('does not fetch when there is no session (enabled gate)', () => {
    const { result } = renderHook(() => useGenreRow(category), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedGetItems).not.toHaveBeenCalled();
  });
});
