// Correlates Radarr/Sonarr queue records to a TMDB id and a numeric download
// percentage, ported from the Kotlin reference's `DownloadProgressProvider`.
// Radarr/Sonarr are the ONLY source of a numeric download percentage in the
// app (Jellyseerr only exposes a text status). Kept as a pure function over
// minimal structural inputs so it is trivially unit-testable and decoupled
// from the Radarr/Sonarr zod schemas.

// The structural inputs below are deliberately permissive (every field
// optional) so this correlator stays decoupled from the exact Radarr/Sonarr
// zod schemas and tolerates partial/degraded payloads - `percentOf` defaults
// size/sizeleft to 0 and the builder skips records/entries missing the keys it
// needs. (The wider-than-strictly-necessary shape is harmless: all consumers
// already defend with `?? 0` / `?? null`.)
export interface QueueRecordInput {
  size?: number;
  sizeleft?: number;
  /** Radarr-only FK back to the movie this transfer belongs to. */
  movieId?: number | null;
  /** Sonarr-only FK back to the series this transfer belongs to. */
  seriesId?: number | null;
}

export interface QueueResponseInput {
  records?: QueueRecordInput[];
}

export interface MovieInput {
  /** Entries without an `id` can't be correlated and are skipped. */
  id?: number;
  tmdbId?: number | null;
}

export interface SeriesInput {
  id?: number;
  /** May be null - not every Sonarr series has a TMDB id (some only carry a TVDB id). */
  tmdbId?: number | null;
}

/** Download completion 0..100, or null if the total size is unknown. */
function percentOf(record: QueueRecordInput): number | null {
  const size = record.size ?? 0;
  const sizeleft = record.sizeleft ?? 0;
  if (size <= 0) return null;
  const raw = ((size - sizeleft) / size) * 100;
  return Math.min(100, Math.max(0, raw));
}

/**
 * @param radarrQueue   `GET /radarr/api/v3/queue` response.
 * @param radarrMovies  `GET /radarr/api/v3/movie` - resolves `movieId -> tmdbId`.
 * @param sonarrQueue   `GET /sonarr/api/v3/queue` response.
 * @param sonarrSeries  `GET /sonarr/api/v3/series` - resolves `seriesId -> tmdbId`.
 * @returns percent (0..100) keyed by tmdbId. When several queue records
 *          resolve to the same tmdbId (e.g. a series with multiple episodes
 *          downloading), the AVERAGE percent is the representative value -
 *          matching `DownloadProgressProvider.kt`'s `list.average()` (a series
 *          with episodes at 20% and 90% reads 55%, not 90%).
 */
export function buildProgressByTmdbId(
  radarrQueue: QueueResponseInput,
  radarrMovies: MovieInput[],
  sonarrQueue: QueueResponseInput,
  sonarrSeries: SeriesInput[],
): Map<number, number> {
  const movieTmdbById = new Map(
    radarrMovies.filter((m) => m.id != null).map((m) => [m.id as number, m.tmdbId ?? null]),
  );
  const seriesTmdbById = new Map(
    sonarrSeries.filter((s) => s.id != null).map((s) => [s.id as number, s.tmdbId ?? null]),
  );

  // Collect every resolved percent per tmdbId first, then average - the
  // Kotlin reference groups then takes `list.average()`.
  const samples = new Map<number, number[]>();

  const accumulate = (tmdbId: number | null | undefined, percent: number | null) => {
    if (tmdbId == null || percent == null) return;
    const list = samples.get(tmdbId);
    if (list) list.push(percent);
    else samples.set(tmdbId, [percent]);
  };

  for (const record of radarrQueue.records ?? []) {
    const tmdbId = record.movieId != null ? movieTmdbById.get(record.movieId) : null;
    accumulate(tmdbId, percentOf(record));
  }

  for (const record of sonarrQueue.records ?? []) {
    const tmdbId = record.seriesId != null ? seriesTmdbById.get(record.seriesId) : null;
    accumulate(tmdbId, percentOf(record));
  }

  const result = new Map<number, number>();
  for (const [tmdbId, list] of samples) {
    const avg = list.reduce((sum, p) => sum + p, 0) / list.length;
    // `.toInt()` in the Kotlin reference truncates toward zero, not rounds.
    result.set(tmdbId, Math.trunc(avg));
  }
  return result;
}
