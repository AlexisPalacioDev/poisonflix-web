import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { getMovieDetails, getRequests, getTvDetails } from '../api/jellyseerr';
import type { JellyseerrRequestDto } from '../api/schemas/jellyseerr';
import { jellyseerrStatusLabel } from '../lib/domain/libraryIndex';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';
import { useDownloadProgress } from './useDownloadProgress';

// Downloads screen data source (projector-feature-map.md §9, walkthrough
// §14). Jellyseerr's active-requests list is the source of truth for WHICH
// titles show up (title membership, status label); `useDownloadProgress`'s
// Radarr/Sonarr correlation only contributes the numeric % overlay on top -
// same split of responsibility as Home's deferred "En camino" row.

export interface DownloadItem {
  /** Jellyseerr request id - the identity `useCancelDownload` needs to delete the request. */
  id: number;
  /** TMDB id, or null on the rare/malformed request whose media record doesn't carry one. */
  tmdbId: number | null;
  title: string;
  posterPath: string | null;
  statusLabel: string;
  /** 0..100 live download %, or undefined when Radarr/Sonarr have no matching queue record. */
  percent?: number;
}

/** A request's TMDB media type; Jellyseerr stores it as a free string. */
function mediaTypeOf(request: JellyseerrRequestDto): 'movie' | 'tv' {
  return request.media.mediaType === 'tv' ? 'tv' : 'movie';
}

/**
 * The request DTO's `media` (`JellyseerrMediaInfoSchema`) carries no
 * title/poster fields at all - only ids and status. The projector enriches
 * each request with its title/poster via a concurrent per-item detail fetch
 * (projector-feature-map.md §9, "enriched with title/poster (concurrent)"),
 * so we do the same here with `useQueries`: one cached TMDB detail lookup per
 * request, sharing the `queryKeys.detail` cache entry with the Detail screen.
 * Until a detail resolves, the tmdbId is the title fallback (never blank).
 */
function toDownloadItem(
  request: JellyseerrRequestDto,
  progressByTmdbId: Map<number, number>,
  enrichment: Map<number, { title: string; posterPath: string | null }>,
): DownloadItem {
  const tmdbId = request.media.tmdbId ?? null;
  const enriched = tmdbId != null ? enrichment.get(tmdbId) : undefined;
  const title = enriched?.title ?? (tmdbId != null ? String(tmdbId) : `#${request.id}`);
  const status = request.media.status;
  const percent = tmdbId != null ? progressByTmdbId.get(tmdbId) : undefined;

  // "Próximamente": the request is approved/queued (Pendiente) or Jellyseerr
  // reports "Descargando" but there's no actual Radarr/Sonarr queue progress
  // yet - i.e. the download hasn't really started. Anything with live progress
  // or already (partially) available keeps its real status.
  const notStarted = (status === 2 || status === 3) && percent == null;

  return {
    id: request.id,
    tmdbId,
    title,
    posterPath: enriched?.posterPath ?? null,
    statusLabel: notStarted ? 'Próximamente' : jellyseerrStatusLabel(status),
    percent,
  };
}

export function useDownloads() {
  const { session } = useAuth();
  const { progressByTmdbId } = useDownloadProgress();

  const query = useQuery({
    queryKey: queryKeys.requests('all'),
    queryFn: () => getRequests('all', 50, 0),
    // Gated on a hydrated session like useLibraryRow - never fires before login.
    enabled: Boolean(session),
    staleTime: 5_000,
    // Projector's Downloads screen auto-refresh cadence (projector-feature-map.md §9).
    refetchInterval: 15_000,
  });

  // Concurrent title/poster enrichment - one detail fetch per request, cached
  // long (metadata is slow-changing) and de-duplicated by tmdbId so revisiting
  // the same title never re-hits TMDB.
  const enrichable = useMemo(() => {
    const seen = new Set<number>();
    const out: { tmdbId: number; mediaType: 'movie' | 'tv' }[] = [];
    for (const request of query.data?.results ?? []) {
      const tmdbId = request.media.tmdbId;
      if (tmdbId == null || seen.has(tmdbId)) continue;
      seen.add(tmdbId);
      out.push({ tmdbId, mediaType: mediaTypeOf(request) });
    }
    return out;
  }, [query.data]);

  const detailQueries = useQueries({
    queries: enrichable.map(({ tmdbId, mediaType }) => ({
      queryKey: queryKeys.detail(mediaType, String(tmdbId)),
      queryFn: () => (mediaType === 'tv' ? getTvDetails(tmdbId) : getMovieDetails(tmdbId)),
      enabled: Boolean(session),
      staleTime: 5 * 60_000,
    })),
  });

  const enrichment = useMemo(() => {
    const map = new Map<number, { title: string; posterPath: string | null }>();
    detailQueries.forEach((result, index) => {
      const entry = enrichable[index];
      const data = result.data;
      if (!entry || !data) return;
      // TMDB movies expose `title`, TV shows expose `name` (schema comment §TV);
      // `title` is optional on the movie type, so pick by truthiness and fall
      // back to the tmdbId so an item is never blank.
      const named = 'title' in data && data.title ? data.title : 'name' in data ? data.name : undefined;
      map.set(entry.tmdbId, {
        title: named ?? String(entry.tmdbId),
        posterPath: data.posterPath ?? null,
      });
    });
    return map;
  }, [detailQueries, enrichable]);

  const items = useMemo(
    () =>
      (query.data?.results ?? []).map((request) =>
        toDownloadItem(request, progressByTmdbId, enrichment),
      ),
    [query.data, progressByTmdbId, enrichment],
  );

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
