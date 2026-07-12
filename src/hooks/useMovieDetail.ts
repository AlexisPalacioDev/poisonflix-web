import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMovieDetails } from '../api/jellyseerr';
import { LibraryIndex, type TitleStatus } from '../lib/domain/libraryIndex';
import { queryKeys } from './queryKeys';
import { useLibraryRow } from './useLibraryRow';

// Detail screen's fetch+badge hook (design.md §2 `useMovieDetail`, tasks.md
// 6.1), ported from `DetailRepositoryImpl.kt`'s detail-fetch + the shared
// `LibraryIndex` join Search already uses (design.md §4.4). `:id` is the
// TMDB id (design.md §7), so detail is fetched from Jellyseerr's
// `/movie/{tmdbId}` endpoint - not a direct Jellyfin lookup - then correlated
// against the Jellyfin library the same way Search's badge join works, so an
// `InLibrary` result carries the real Jellyfin item id the "Reproducir"
// action needs to navigate to `/player/:id`.

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

export function useMovieDetail(tmdbId: string) {
  const idNum = Number(tmdbId);
  const validId = Number.isFinite(idNum);

  const detailQuery = useQuery({
    queryKey: queryKeys.item(tmdbId),
    queryFn: () => getMovieDetails(idNum),
    enabled: validId,
  });

  // Reuses Home/Search's Library row query (same query key -> same cache
  // entry) so this never issues an extra Jellyfin fetch on its own.
  const library = useLibraryRow();

  const status = useMemo<TitleStatus | null>(() => {
    if (!detailQuery.data) return null;
    const index = new LibraryIndex(library.data?.Items ?? []);
    return index.resolve(
      detailQuery.data.id,
      detailQuery.data.title,
      parseYear(detailQuery.data.releaseDate),
      detailQuery.data.mediaInfo?.status ?? null,
    );
  }, [detailQuery.data, library.data]);

  return {
    detail: detailQuery.data,
    status,
    isLoading: validId && (detailQuery.isLoading || library.isLoading),
    isError: !validId || detailQuery.isError,
    refetch: detailQuery.refetch,
  };
}
