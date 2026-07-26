import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMovieDetails, getTvDetails } from '../api/jellyseerr';
import type {
  JellyseerrMediaInfo,
  JellyseerrMovieDetails,
  JellyseerrTvDetails,
} from '../api/schemas/jellyseerr';
import { LibraryIndex, type TitleStatus } from '../lib/domain/libraryIndex';
import { queryKeys } from './queryKeys';
import { useLibraryRow } from './useLibraryRow';

// Unified detail hook for both movies and TV (replaces the movie-only
// `useMovieDetail`). `:id` is the TMDB id; the caller supplies `mediaType`
// (from the `/detail/:id?type=` param) because a bare TMDB id is ambiguous —
// TMDB reuses the same numeric ids across the movie and tv namespaces, so
// hitting `/movie/{id}` for a series could silently return a different movie.
// TMDB's TV field names (`name`/`firstAirDate`/`episodeRunTime`) are normalized
// onto the movie-shaped detail so the detail screen stays media-agnostic.

export type MediaType = 'movie' | 'tv';

export interface NormalizedDetail {
  id: number;
  title: string;
  overview: string | null;
  releaseDate: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number | null;
  runtime: number | null;
  mediaInfo: JellyseerrMediaInfo | null;
}

function normalizeMovie(m: JellyseerrMovieDetails): NormalizedDetail {
  return {
    id: m.id,
    title: m.title,
    overview: m.overview ?? null,
    releaseDate: m.releaseDate ?? null,
    posterPath: m.posterPath ?? null,
    backdropPath: m.backdropPath ?? null,
    voteAverage: m.voteAverage ?? null,
    runtime: m.runtime ?? null,
    mediaInfo: m.mediaInfo ?? null,
  };
}

function normalizeTv(t: JellyseerrTvDetails): NormalizedDetail {
  return {
    id: t.id,
    title: t.name,
    overview: t.overview ?? null,
    releaseDate: t.firstAirDate ?? null,
    posterPath: t.posterPath ?? null,
    backdropPath: t.backdropPath ?? null,
    voteAverage: t.voteAverage ?? null,
    // A series has no single runtime; surface the typical episode length.
    runtime: t.episodeRunTime?.[0] ?? null,
    mediaInfo: t.mediaInfo ?? null,
  };
}

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

export function useTitleDetail(tmdbId: string, mediaType: MediaType) {
  const idNum = Number(tmdbId);
  // `Number('')` is 0, NOT NaN, so an isFinite check alone lets an empty id
  // through and fires `GET /jellyseerr/api/v1/movie/0` -> 500 (x4, counting
  // react-query retries) on every mount that renders a detail with no
  // selection. TMDB ids are positive, so require > 0.
  const validId = Number.isFinite(idNum) && idNum > 0;

  const detailQuery = useQuery({
    queryKey: queryKeys.detail(mediaType, tmdbId),
    queryFn: async (): Promise<NormalizedDetail> =>
      mediaType === 'tv'
        ? normalizeTv(await getTvDetails(idNum))
        : normalizeMovie(await getMovieDetails(idNum)),
    enabled: validId,
  });

  // Same shared LibraryIndex join Search/movie-detail use (design.md §4.4),
  // so an InLibrary title still carries the real Jellyfin item id.
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
