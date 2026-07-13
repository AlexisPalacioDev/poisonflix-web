import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import { LibraryIndex } from '../lib/domain/libraryIndex';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Independent Jellyfin SERIES-library resolver for Detail's two-pane layout.
//
// WHY THIS EXISTS (live bug, not covered by unit mocks): the title-level
// status in `useTitleDetail` is derived from `useLibraryRow`, which fetches
// `IncludeItemTypes=Movie` ONLY (movies, limit 40). So NO series ever
// resolves to `InLibrary` through that path - every series in the Jellyfin
// library still falls back to its Jellyseerr status (Requesting/Requestable),
// and the two-pane branch that was gated on `InLibrary` was unreachable live.
//
// This hook resolves the Jellyfin series item id on its OWN series fetch
// (`IncludeItemTypes=Series`, Recursive, `Fields=ProviderIds`), matched by
// `ProviderIds.Tmdb === tmdbId` with a normalized title+year fallback - it
// reuses `LibraryIndex` verbatim for that match (same tmdb-then-title/year
// rule the rest of the app uses), then reads back the matched item id. The
// series-membership decision is thus fully decoupled from the movies-only
// row: a series that is in the library resolves here REGARDLESS of what
// Jellyseerr reports its status as (walkthrough §20: a "Parcialmente
// disponible" series still shows the episode browser).
//
// Keyed via the existing `queryKeys.library` factory with SERIES params, so it
// never collides with `useLibraryRow`'s movies key and adds nothing to
// `queryKeys.ts`.

const SERIES_LIBRARY_PARAMS = {
  includeItemTypes: 'Series',
  recursive: true,
  limit: 200,
  fields: 'ProviderIds',
} as const;

export function useSeriesLibraryId(
  tmdbId: number | null,
  title: string | null,
  releaseYear: number | null,
  enabled = true,
): { seriesJellyfinItemId: string | null; isLoading: boolean } {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  const query = useQuery({
    queryKey: queryKeys.library(userId ?? '', SERIES_LIBRARY_PARAMS),
    queryFn: () => getItems(userId as string, SERIES_LIBRARY_PARAMS),
    enabled: enabled && Boolean(userId),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

  const seriesJellyfinItemId = useMemo<string | null>(() => {
    if (!query.data || tmdbId == null) return null;
    const index = new LibraryIndex(query.data.Items);
    // `null` Jellyseerr status: we only want the Jellyfin-presence answer here
    // (tmdb match, or title+year fallback), never a Jellyseerr-derived one.
    const status = index.resolve(tmdbId, title ?? '', releaseYear, null);
    return status.kind === 'InLibrary' ? status.jellyfinItemId : null;
  }, [query.data, tmdbId, title, releaseYear]);

  return { seriesJellyfinItemId, isLoading: query.isLoading };
}
