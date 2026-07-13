import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import { discoverMovies } from '../api/jellyseerr';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import type { JellyseerrSearchResult } from '../api/schemas/jellyseerr';
import type { Category } from '../lib/domain/categories';
import { distinctBy } from '../lib/domain/dedup';
import { displayTitle } from '../lib/domain/displayTitle';
import { LibraryIndex, type TitleStatus } from '../lib/domain/libraryIndex';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// One of Home's 10 mixed genre rows (projector-feature-map.md §3): each row
// concatenates (a) library items of that genre and (b) TMDB discover results
// for that genre, dropping adult results and titles already owned. Ported
// from `MediaRepositoryImpl.kt:60-104`'s `getCategoryRow`.

const GENRE_ROW_PARAMS = {
  // Movie AND Series, unlike Library's Movie-only MVP row (useLibraryRow.ts) -
  // the native `getCategoryRow` scans every non-adult library regardless of type.
  includeItemTypes: 'Movie,Series',
  recursive: true,
  limit: 40,
} as const;

export interface GenreRowItem {
  /** Detail route id (design.md §7): TMDB id when the source item has one,
   * else the Jellyfin item id - same fallback HomeScreen's
   * `toLibraryPosterItem` uses. Also this row's dedup key (library wins over
   * a duplicate discover entry sharing the same id). */
  id: string;
  title: string;
  status: TitleStatus;
  /** Set for library-sourced items; poster resolves via `jellyfinPosterUrl`
   * (needs the session token, which this hook doesn't carry - left to the caller). */
  jellyfinItem?: JellyfinItem;
  /** Set for discover-sourced items; poster resolves via `tmdbPosterUrl`. */
  posterPath?: string | null;
}

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function fromLibraryItem(item: JellyfinItem): GenreRowItem {
  return {
    id: item.ProviderIds?.Tmdb ?? item.Id,
    title: displayTitle(item.Name),
    status: { kind: 'InLibrary', jellyfinItemId: item.Id, matchedByFallback: false },
    jellyfinItem: item,
  };
}

/**
 * Pure merge step, exported separately so it's unit-testable without mocking
 * `getItems`/`discoverMovies` or standing up a QueryClient (dedup.ts/
 * libraryIndex.ts's testing style). `libraryIndex` correlates each discover
 * result against the library items already fetched for this row; a result
 * that resolves to `InLibrary` is dropped here because the matching library
 * item (mapped separately, above) already represents it on screen - showing
 * both would duplicate the same title.
 */
export function mergeGenreRow(
  libraryItems: JellyfinItem[],
  discoverResults: JellyseerrSearchResult[],
): GenreRowItem[] {
  const libraryIndex = new LibraryIndex(libraryItems);
  const libraryRowItems = libraryItems.map(fromLibraryItem);

  const discoverRowItems: GenreRowItem[] = [];
  for (const result of discoverResults) {
    if (result.adult) continue;

    const title = result.title ?? result.name ?? 'Sin título';
    const year = parseYear(result.releaseDate ?? result.firstAirDate);
    const status = libraryIndex.resolve(result.id, title, year, result.mediaInfo?.status ?? null);
    if (status.kind === 'InLibrary') continue;

    discoverRowItems.push({ id: String(result.id), title, status, posterPath: result.posterPath });
  }

  // Library wins on id collision (`distinctBy` keeps the first occurrence) -
  // belt-and-suspenders on top of the `InLibrary` filter above, since that
  // filter already removes the vast majority of duplicates.
  return distinctBy([...libraryRowItems, ...discoverRowItems], (entry) => entry.id);
}

async function fetchGenreRow(userId: string, category: Category): Promise<GenreRowItem[]> {
  // Row isolation (ADR-3): `Promise.allSettled`, not `Promise.all` - a
  // slow/failed discover call must never blank the library half of the row.
  // (Library failure is handled differently below - it fails the whole row,
  // since it's this row's primary content, same as useLibraryRow.)
  const [libraryResult, discoverResult] = await Promise.allSettled([
    getItems(userId, { ...GENRE_ROW_PARAMS, genres: category.jellyfinGenre }),
    discoverMovies({ genre: category.tmdbGenreId }),
  ]);

  // A failed library fetch fails the whole row (it's the primary,
  // Library-row-equivalent content) - react-query surfaces this as
  // `isError`/`onRetry`, same as useLibraryRow. Only discover is allowed to
  // degrade silently to an empty list, per the row-isolation rule above.
  if (libraryResult.status === 'rejected') throw libraryResult.reason;

  const discoverItems = discoverResult.status === 'fulfilled' ? discoverResult.value.results : [];

  return mergeGenreRow(libraryResult.value.Items, discoverItems);
}

export function useGenreRow(category: Category) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  return useQuery({
    queryKey: queryKeys.genreRow(category.id, userId ?? ''),
    queryFn: () => fetchGenreRow(userId as string, category),
    enabled: Boolean(userId),
    // Same cadence as useLibraryRow/useTrendingRow (design.md §4.2).
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
