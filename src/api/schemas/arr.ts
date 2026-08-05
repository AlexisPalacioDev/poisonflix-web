import { z } from 'zod';

// Radarr/Sonarr v3 REST schemas, ported from the Kotlin reference's
// `RadarrDto.kt` / `SonarrDto.kt` / `ArrApi.kt`'s `ArrQueueRecord`. Only the
// fields the web client actually consumes are declared; unknown fields are
// ignored by zod's default (non-strict) object parsing, mirroring the Kotlin
// `ignoreUnknownKeys = true` Json config.

// ---------------------------------------------------------------------------
// Queue: GET api/v3/queue (shared shape across Radarr/Sonarr)
// ---------------------------------------------------------------------------

export const ArrQueueRecordSchema = z.object({
  // Queue-record id - needed to cancel this specific transfer via
  // `DELETE api/v3/queue/{id}`.
  id: z.number().nullable().optional(),
  size: z.number().default(0),
  sizeleft: z.number().default(0),
  // Download-client status ("downloading" | "queued" | "paused" | "completed" |
  // "failed" | "warning" | "delay" | ...) - the *arr apps pass this straight
  // through from the client, so the exact vocabulary varies by client. Only
  // "downloading"/"completed" are pattern-matched by name below; everything
  // else falls through to "queued, not started yet".
  status: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  // Sonarr's OWN post-download pipeline state - distinct from `status` above.
  // A record can be `status: "completed"` (the download client is done) while
  // `trackedDownloadState` is still "importPending"/"importing": Sonarr hasn't
  // moved the file into the library yet. Episode-status honesty (owner's
  // "En cola"/"Descargando" complaint) hinges on this field: without it,
  // sizeleft:0 was indistinguishable from "still transferring".
  trackedDownloadState: z.string().nullable().optional(),
  // Sonarr's health flag for this transfer: "ok" | "warning" | "error". A
  // stuck/broken download must surface this - see `errorMessage`.
  trackedDownloadStatus: z.string().nullable().optional(),
  // Human-readable failure/warning detail (e.g. "no files found are eligible
  // for import"). `null` on a healthy transfer.
  errorMessage: z.string().nullable().optional(),
  // Radarr-only FK back to the movie this transfer belongs to.
  movieId: z.number().nullable().optional(),
  // Sonarr-only FKs back to the series/episode this transfer belongs to.
  seriesId: z.number().nullable().optional(),
  episodeId: z.number().nullable().optional(),
});
export type ArrQueueRecord = z.infer<typeof ArrQueueRecordSchema>;

export const ArrQueueResponseSchema = z.object({
  records: z.array(ArrQueueRecordSchema).default([]),
});
export type ArrQueueResponse = z.infer<typeof ArrQueueResponseSchema>;

// ---------------------------------------------------------------------------
// Radarr: GET api/v3/movie - identity resolution (movieId -> tmdbId).
// ---------------------------------------------------------------------------

export const RadarrMovieSchema = z.object({
  id: z.number(),
  tmdbId: z.number().nullable().optional(),
  monitored: z.boolean().default(false),
  hasFile: z.boolean().default(false),
  title: z.string().nullable().optional(),
});
export type RadarrMovie = z.infer<typeof RadarrMovieSchema>;

// ---------------------------------------------------------------------------
// Sonarr: GET api/v3/series - identity resolution (seriesId -> tmdbId).
// ---------------------------------------------------------------------------

export const SonarrSeriesSchema = z.object({
  id: z.number(),
  tvdbId: z.number().nullable().optional(),
  tmdbId: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
});
export type SonarrSeries = z.infer<typeof SonarrSeriesSchema>;

// ---------------------------------------------------------------------------
// Sonarr: GET api/v3/episode?seriesId= - full canonical episode list.
// ---------------------------------------------------------------------------

export const SonarrEpisodeSchema = z.object({
  id: z.number(),
  seasonNumber: z.number(),
  episodeNumber: z.number(),
  title: z.string().nullable().optional(),
  hasFile: z.boolean().default(false),
  monitored: z.boolean().default(false),
  seriesId: z.number(),
});
export type SonarrEpisode = z.infer<typeof SonarrEpisodeSchema>;
