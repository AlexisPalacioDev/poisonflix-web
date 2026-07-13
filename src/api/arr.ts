import { apiFetch } from '../lib/http/client';
import {
  ArrQueueResponseSchema,
  RadarrMovieSchema,
  SonarrEpisodeSchema,
  SonarrSeriesSchema,
  type ArrQueueResponse,
  type RadarrMovie,
  type SonarrEpisode,
  type SonarrSeries,
} from './schemas/arr';

// Radarr/Sonarr client, ported from `ArrApi.kt` - the ONLY source of a
// numeric download percentage in the app (Jellyseerr only exposes a text
// status). Every call goes through `apiFetch('radarr' | 'sonarr', ...)`: the
// same-origin proxy injects each backend's X-Api-Key server-side
// (vite.config.ts), so no credential ever reaches this module.

// ---------------------------------------------------------------------------
// Radarr
// ---------------------------------------------------------------------------

/** Current download queue; each record's `movieId` is matched against `getRadarrMovies()`'s `tmdbId`. */
export async function getRadarrQueue(): Promise<ArrQueueResponse> {
  return apiFetch('radarr', '/api/v3/queue', { schema: ArrQueueResponseSchema });
}

/** All movies known to Radarr; matched to the app's title by `tmdbId`. */
export async function getRadarrMovies(): Promise<RadarrMovie[]> {
  return apiFetch('radarr', '/api/v3/movie', { schema: RadarrMovieSchema.array() });
}

/** Removes the record AND the downloaded file in one call. */
export async function deleteRadarrMovie(id: number, deleteFiles = true): Promise<void> {
  await apiFetch('radarr', `/api/v3/movie/${id}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
}

/** Stops the client-side transfer without blocklisting (never re-grabbed as "failed"). */
export async function deleteRadarrQueueItem(
  id: number,
  removeFromClient = true,
  blocklist = false,
): Promise<void> {
  await apiFetch(
    'radarr',
    `/api/v3/queue/${id}?removeFromClient=${removeFromClient}&blocklist=${blocklist}`,
    { method: 'DELETE' },
  );
}

/**
 * Raw single-movie fetch - deliberately schema-less. The unmonitor flow reads
 * the FULL object here, flips `monitored`, and PUTs it back unmodified;
 * a typed round-trip would silently drop every field this module doesn't
 * model and corrupt the record (mirrors `RadarrApi.getMovie`/`putMovie`).
 */
export async function getRadarrMovieRaw(id: number): Promise<unknown> {
  return apiFetch('radarr', `/api/v3/movie/${id}`);
}

/** Full-object PUT - `body` must be the complete object from `getRadarrMovieRaw`, not a partial one. */
export async function putRadarrMovieRaw(id: number, body: unknown): Promise<unknown> {
  return apiFetch('radarr', `/api/v3/movie/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Sonarr
// ---------------------------------------------------------------------------

/**
 * Current download queue. `includeEpisode` mirrors `SonarrApi.getEpisodeQueue`
 * (title-level polling doesn't need it; episode-level browsing does, to map
 * a record's % back to a specific episode).
 */
export async function getSonarrQueue(includeEpisode = false): Promise<ArrQueueResponse> {
  return apiFetch('sonarr', `/api/v3/queue?includeEpisode=${includeEpisode}`, {
    schema: ArrQueueResponseSchema,
  });
}

/** All series known to Sonarr; matched to the app's title by `tmdbId`. */
export async function getSonarrSeries(): Promise<SonarrSeries[]> {
  return apiFetch('sonarr', '/api/v3/series', { schema: SonarrSeriesSchema.array() });
}

/** Every episode of a series (with `hasFile`), the full canonical list. */
export async function getSonarrEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
  return apiFetch('sonarr', `/api/v3/episode?seriesId=${seriesId}`, {
    schema: SonarrEpisodeSchema.array(),
  });
}

/** Removes the record AND the downloaded file(s) in one call. */
export async function deleteSonarrSeries(id: number, deleteFiles = true): Promise<void> {
  await apiFetch('sonarr', `/api/v3/series/${id}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
}

/** Stops the client-side transfer without blocklisting (never re-grabbed as "failed"). */
export async function deleteSonarrQueueItem(
  id: number,
  removeFromClient = true,
  blocklist = false,
): Promise<void> {
  await apiFetch(
    'sonarr',
    `/api/v3/queue/${id}?removeFromClient=${removeFromClient}&blocklist=${blocklist}`,
    { method: 'DELETE' },
  );
}

/** Batch-unmonitors episodes so they're not auto re-grabbed after a cancel. */
export async function putSonarrEpisodesMonitor(episodeIds: number[], monitored: boolean): Promise<void> {
  await apiFetch('sonarr', '/api/v3/episode/monitor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeIds, monitored }),
  });
}
