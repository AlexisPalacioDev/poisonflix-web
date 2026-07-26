import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { search } from '../api/jellyseerr';
import type { JellyseerrSearchResult } from '../api/schemas/jellyseerr';
import { distinctBy } from '../lib/domain/dedup';
import { LibraryIndex, type TitleStatus } from '../lib/domain/libraryIndex';
import { queryKeys } from './queryKeys';
import { useDebouncedValue } from './useDebouncedValue';
import { useLibraryRow } from './useLibraryRow';
import { useTrendingRow } from './useTrendingRow';

// Search's ViewModel-equivalent (design.md §4.3, search spec), ported from
// `SearchViewModel.kt` L106-119/L238. Debounces the raw query 350ms and only
// fires the Jellyseerr search once the settled value is 2+ chars - below
// that, no request is issued (search spec: "Below minimum length").

const MIN_QUERY_LENGTH = 2;

export interface SearchResultEntry {
  result: JellyseerrSearchResult;
  status: TitleStatus;
}

/** Result title, mirroring the movie/tv `title`/`name` split already used by Home. */
export function resultTitle(result: JellyseerrSearchResult): string {
  return result.title ?? result.name ?? 'Sin título';
}

/** Release year parsed from whichever date field the media type carries, or `null`. */
export function resultYear(result: JellyseerrSearchResult): number | null {
  const dateStr = result.releaseDate ?? result.firstAirDate;
  if (!dateStr) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

export function useSearch(rawQuery: string) {
  const debounced = useDebouncedValue(rawQuery, 350);
  const trimmed = debounced.trim();
  const enabled = trimmed.length >= MIN_QUERY_LENGTH;

  const searchQuery = useQuery({
    queryKey: queryKeys.search(trimmed),
    queryFn: () => search(trimmed),
    enabled,
    // ~30s stale per design.md §4.2 - re-focusing a recent query is instant.
    staleTime: 30_000,
  });

  // Below the minimum query length the carousel would render nothing but an
  // "escribí 2 caracteres" placeholder, which wastes the whole screen. Fall
  // back to Home's Trending row as the suggestion source: SAME query key ->
  // same react-query cache entry, so arriving from Home costs no extra
  // request, and no new endpoint is introduced.
  const trendingQuery = useTrendingRow();

  // Reuses Home's Library row query (same query key -> same cache entry) so
  // the badge join never issues an extra Jellyfin request Home hasn't
  // already made (design.md §4.4: correlate against the library).
  const library = useLibraryRow();

  // Both queries resolve the same `JellyseerrSearchResponse` shape, so the
  // dedup + LibraryIndex badge join below is identical for either source -
  // suggestions get "En biblioteca"/"Pedir" badges exactly like results do.
  const active = enabled ? searchQuery : trendingQuery;

  const entries = useMemo<SearchResultEntry[]>(() => {
    if (!active.data) return [];

    const deduped = distinctBy(active.data.results, (result) => result.id);
    // TV/series results are deferred (search spec's Deferred section) -
    // movie/tv are the only media types with a poster+detail story in the
    // MVP; "person" entries from the multi-search endpoint are dropped.
    const titles = deduped.filter((result) => result.mediaType === 'movie' || result.mediaType === 'tv');

    const index = new LibraryIndex(library.data?.Items ?? []);

    return titles.map((result) => ({
      result,
      status: index.resolve(
        result.id,
        resultTitle(result),
        resultYear(result),
        result.mediaInfo?.status ?? null,
      ),
    }));
  }, [active.data, library.data]);

  return {
    query: rawQuery,
    debouncedQuery: trimmed,
    enabled,
    /** True while the entries are trending suggestions rather than search hits. */
    isSuggestions: !enabled,
    isLoading: active.isLoading,
    isError: active.isError,
    entries,
    refetch: active.refetch,
  };
}
