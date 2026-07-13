import { useMutation } from '@tanstack/react-query';
import {
  deleteRadarrQueueItem,
  deleteSonarrQueueItem,
  getRadarrMovieRaw,
  getRadarrMovies,
  getRadarrQueue,
  getSonarrEpisodes,
  getSonarrQueue,
  getSonarrSeries,
  putRadarrMovieRaw,
  putSonarrEpisodesMonitor,
} from '../api/arr';
import { deleteRequest } from '../api/jellyseerr';

// Cancel-download flow (Downloads screen, projector-feature-map.md §9 "Cancel
// flow"), ported from `RequestRepositoryImpl.cancelDownload`. Radarr/Sonarr
// are treated as a best-effort side channel throughout this dev environment
// they 401 without a provisioned API key (constraint in the task brief) - so
// every Radarr/Sonarr step below is independently try/caught: an empty queue,
// an unresolvable movie/series, or an outright 401 are all normal, silent
// no-ops here. Only the LAST step - actually telling Jellyseerr to drop the
// request - is allowed to throw, since that's the one action the cancel flow
// can't silently skip: if it fails, the title genuinely never left the
// requests list and the caller needs to know.

export interface CancelDownloadParams {
  /** May be null on a request whose media record carries no TMDB id: the
   * Radarr/Sonarr resolution is skipped, but the Jellyseerr request is still
   * deleted (so the item genuinely leaves the queue, not just the UI). */
  tmdbId: number | null;
  requestId: number;
}

async function resolveRadarrMovieId(tmdbId: number): Promise<number | null> {
  try {
    const movies = await getRadarrMovies();
    return movies.find((movie) => movie.tmdbId === tmdbId)?.id ?? null;
  } catch {
    return null;
  }
}

async function resolveSonarrSeriesId(tmdbId: number): Promise<number | null> {
  try {
    const series = await getSonarrSeries();
    return series.find((s) => s.tmdbId === tmdbId)?.id ?? null;
  } catch {
    return null;
  }
}

/** Stops the client-side transfer(s) for a Radarr movie. Empty/missing queue is normal. */
async function cancelRadarrQueue(movieId: number): Promise<void> {
  try {
    const queue = await getRadarrQueue();
    const matches = queue.records.filter((record) => record.movieId === movieId && record.id != null);
    await Promise.all(matches.map((record) => deleteRadarrQueueItem(record.id as number, true, false)));
  } catch {
    // Best-effort - an unreachable/empty queue must not block the rest of the flow.
  }
}

/** Stops the client-side transfer(s) for a Sonarr series. Empty/missing queue is normal. */
async function cancelSonarrQueue(seriesId: number): Promise<void> {
  try {
    const queue = await getSonarrQueue();
    const matches = queue.records.filter((record) => record.seriesId === seriesId && record.id != null);
    await Promise.all(matches.map((record) => deleteSonarrQueueItem(record.id as number, true, false)));
  } catch {
    // Best-effort - same rationale as cancelRadarrQueue.
  }
}

/** Unmonitors the movie so it's not auto re-grabbed after a cancel. */
async function unmonitorRadarrMovie(movieId: number): Promise<void> {
  try {
    const raw = await getRadarrMovieRaw(movieId);
    await putRadarrMovieRaw(movieId, { ...(raw as Record<string, unknown>), monitored: false });
  } catch {
    // Best-effort - a missing/unreachable Radarr record must not block cancel.
  }
}

/** Unmonitors only the episodes that were still pending (monitored, no file yet). */
async function unmonitorSonarrSeries(seriesId: number): Promise<void> {
  try {
    const episodes = await getSonarrEpisodes(seriesId);
    const pendingIds = episodes.filter((ep) => ep.monitored && !ep.hasFile).map((ep) => ep.id);
    if (pendingIds.length > 0) {
      await putSonarrEpisodesMonitor(pendingIds, false);
    }
  } catch {
    // Best-effort - same rationale as unmonitorRadarrMovie.
  }
}

async function cancelDownload({ tmdbId, requestId }: CancelDownloadParams): Promise<void> {
  // Step 1: resolve tmdbId -> Radarr movie and/or Sonarr series identity.
  // A title can legitimately match only one (or neither, if Radarr/Sonarr
  // haven't picked it up yet / are unreachable) - both lookups are independent.
  const [radarrMovieId, sonarrSeriesId] = tmdbId == null
    ? [null, null]
    : await Promise.all([resolveRadarrMovieId(tmdbId), resolveSonarrSeriesId(tmdbId)]);

  // Step 2 + 3: stop the transfer, then unmonitor so it isn't re-grabbed.
  if (radarrMovieId != null) {
    await cancelRadarrQueue(radarrMovieId);
    await unmonitorRadarrMovie(radarrMovieId);
  }

  if (sonarrSeriesId != null) {
    await cancelSonarrQueue(sonarrSeriesId);
    await unmonitorSonarrSeries(sonarrSeriesId);
  }

  // Step 4: drop the Jellyseerr request itself - the only step allowed to throw.
  await deleteRequest(requestId);
}

export function useCancelDownload() {
  return useMutation({ mutationFn: cancelDownload });
}
