import { useQuery } from '@tanstack/react-query';
import { getRadarrMovies, getRadarrQueue, getSonarrQueue, getSonarrSeries } from '../api/arr';
import type { ArrQueueResponse } from '../api/schemas/arr';
import { buildProgressByTmdbId } from '../lib/domain/downloadProgress';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Resolve a single backend call, degrading a rejection to a benign fallback.
// Ports `DownloadProgressProvider.kt`'s per-call `runCatching { }.getOrNull()`:
// the four Radarr/Sonarr fetches are INDEPENDENT, so one backend failing (e.g.
// an unconfigured Radarr proxy 401ing) must never blank the OTHER backend's
// perfectly good progress. `Promise.all` would reject the whole queryFn on the
// first rejection and discard Sonarr's data along with Radarr's.
async function settled<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

const EMPTY_QUEUE: ArrQueueResponse = { records: [] };

// Live download-% polling source for the Downloads screen and Detail's
// live-% overlay (later slices). Fetches all four Radarr/Sonarr sources in
// one queryFn and folds them into a single tmdbId -> percent map via the
// pure `buildProgressByTmdbId` correlator, mirroring the Kotlin reference's
// `DownloadProgressProvider` (its 8s in-memory TTL cache becomes this query's
// `staleTime`, so several screens polling independently coalesce into one
// fetch per window instead of hammering Radarr/Sonarr).

export function useDownloadProgress() {
  const { session } = useAuth();

  const query = useQuery({
    queryKey: queryKeys.downloadProgress(),
    queryFn: async () => {
      // allSettled semantics via per-call fallbacks: a 401/500 from one *arr
      // backend degrades only that backend's contribution to empty, leaving
      // the others intact (see `settled` above).
      const [radarrQueue, radarrMovies, sonarrQueue, sonarrSeries] = await Promise.all([
        settled(getRadarrQueue(), EMPTY_QUEUE),
        settled(getRadarrMovies(), []),
        settled(getSonarrQueue(), EMPTY_QUEUE),
        settled(getSonarrSeries(), []),
      ]);
      return buildProgressByTmdbId(radarrQueue, radarrMovies, sonarrQueue, sonarrSeries);
    },
    // Gated on a hydrated session like useLibraryRow - never fires before login.
    enabled: Boolean(session),
    staleTime: 8_000,
    // Live-refresh the download percentages without a manual reload, matching the
    // Downloads list cadence in useDownloads (15s). Without this the queue was
    // fetched once on mount and the percent stayed frozen until the user refreshed.
    refetchInterval: 15_000,
  });

  return {
    progressByTmdbId: query.data ?? new Map<number, number>(),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
