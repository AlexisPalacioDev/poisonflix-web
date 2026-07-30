import { z } from 'zod';

// Música feature schemas. These mirror the poisonflix-music-worker's own JSON
// contract (infra/music-worker/server.py), proxied verbatim by the BFF under
// /bff/music/*. The frontend does not own that service, so — like the BFF
// schemas — these track its documented shape directly.

// ---------------------------------------------------------------------------
// Search: GET /bff/music/search?q=&limit=
// ---------------------------------------------------------------------------

// Which surface the worker searches. `auto` lets it pick (clean YT Music
// metadata first, YouTube as fallback); the explicit values force one source
// so the user can toggle between them from the search bar.
export const MusicSourceSchema = z.enum(['auto', 'ytmusic', 'youtube']);
export type MusicSource = z.infer<typeof MusicSourceSchema>;

// A single playable track. This is the historical `song` shape; the rest of the
// Música feature (rows, per-result download, player) treats `MusicSearchResult`
// as this song type, so it stays the exported song contract untouched.
export const MusicSearchResultSchema = z.object({
  videoId: z.string(),
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  artists: z.array(z.string()).default([]),
  album: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  // "ytmusic" (clean song metadata) or "youtube" (fallback surface).
  source: z.string().nullable().optional(),
  // Optional genre tag the worker may attach (present on some YT Music hits).
  genre: z.string().nullable().optional(),
  // Set by the worker when this exact videoId is already in the library: the
  // row then plays straight from Jellyfin (via `jellyfinItemId`) instead of
  // offering "Descargar", and the worker floats these results to the top.
  downloaded: z.boolean().optional().default(false),
  jellyfinItemId: z.string().nullable().optional(),
  // This user's thumb on the track: 1 up, -1 down, 0 none. Keyed by videoId in
  // the worker rather than in Jellyfin, because the tracks most worth rejecting
  // are radio suggestions that were never downloaded and so have no Jellyfin
  // item to hang a rating on.
  rating: z.number().optional().default(0),
});
export type MusicSearchResult = z.infer<typeof MusicSearchResultSchema>;

// The worker now tags every search / recommendation hit with a `type`
// discriminator so albums and playlists can ride the same feed as songs. Songs
// keep the exact `MusicSearchResult` shape plus `type:"song"`.
export const MusicSongResultSchema = MusicSearchResultSchema.extend({
  type: z.literal('song'),
});
export type MusicSongResult = z.infer<typeof MusicSongResultSchema>;

// An album collection: downloaded as a batch via its `browseId`. `thumbnailUrl`
// is an external YouTube cover (used directly, never through the Jellyfin proxy).
export const MusicAlbumResultSchema = z.object({
  type: z.literal('album'),
  browseId: z.string(),
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  trackCount: z.number().nullable().optional(),
  year: z.union([z.number(), z.string()]).nullable().optional(),
});
export type MusicAlbumResult = z.infer<typeof MusicAlbumResultSchema>;

// A playlist collection: downloaded as a batch via its `playlistId`.
export const MusicPlaylistResultSchema = z.object({
  type: z.literal('playlist'),
  playlistId: z.string(),
  title: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  trackCount: z.number().nullable().optional(),
});
export type MusicPlaylistResult = z.infer<typeof MusicPlaylistResultSchema>;

// The typed result union. A `preprocess` step defaults a missing `type` to
// "song" so responses from a not-yet-upgraded worker still parse as tracks.
export const MusicResultItemSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && !('type' in (value as Record<string, unknown>))) {
    return { ...(value as Record<string, unknown>), type: 'song' };
  }
  return value;
}, z.discriminatedUnion('type', [MusicSongResultSchema, MusicAlbumResultSchema, MusicPlaylistResultSchema]));
export type MusicResultItem = z.infer<typeof MusicResultItemSchema>;

export const MusicSearchResponseSchema = z.object({
  results: z.array(MusicResultItemSchema).default([]),
});
export type MusicSearchResponse = z.infer<typeof MusicSearchResponseSchema>;

// ---------------------------------------------------------------------------
// Recommendations: GET /bff/music/recommendations?seed=&limit=
// Same `song` shape as search, so it reuses MusicSearchResponseSchema.
// ---------------------------------------------------------------------------

export const MusicRecommendationsResponseSchema = MusicSearchResponseSchema;
export type MusicRecommendationsResponse = z.infer<typeof MusicRecommendationsResponseSchema>;

// ---------------------------------------------------------------------------
// Downloads: POST /bff/music/downloads, GET /bff/music/downloads/:jobId
// ---------------------------------------------------------------------------

export const MusicJobStateSchema = z.enum([
  'queued',
  'downloading',
  'scanning',
  'done',
  'failed',
]);
export type MusicJobState = z.infer<typeof MusicJobStateSchema>;

export const MusicDownloadResponseSchema = z.object({
  jobId: z.string(),
  state: MusicJobStateSchema,
});
export type MusicDownloadResponse = z.infer<typeof MusicDownloadResponseSchema>;

export const MusicJobSchema = z.object({
  id: z.string(),
  state: MusicJobStateSchema,
  error: z.string().nullable().optional(),
  videoId: z.string().nullable().optional(),
  jellyfinItemId: z.string().nullable().optional(),
});
export type MusicJob = z.infer<typeof MusicJobSchema>;

// ---------------------------------------------------------------------------
// Playlist / album batch download:
//   POST /bff/music/playlists {playlistId} | {browseId} | {url}
//                                           -> 202 {batchId,count,jobIds}
//   GET  /bff/music/playlists/:batchId      -> {batchId,total,done,failed,jobs[]}
// ---------------------------------------------------------------------------

export const MusicPlaylistBatchSchema = z.object({
  batchId: z.string(),
  count: z.number().default(0),
  jobIds: z.array(z.string()).default([]),
});
export type MusicPlaylistBatch = z.infer<typeof MusicPlaylistBatchSchema>;

// The batch endpoint keys jobs by `jobId`, like every other job payload here,
// and can report `unknown` for a job id it no longer holds state for (a worker
// restart drops the in-memory map). This schema required `id` and rejected
// `unknown`, so EVERY poll of a playlist/album download failed validation: the
// card sat on "Descargar" forever with no progress and no error, while the
// download completed fine server-side. See music-worker/server.py batch_status.
export const MusicBatchJobSchema = z.object({
  jobId: z.string(),
  state: z.union([MusicJobStateSchema, z.literal('unknown')]),
  title: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  videoId: z.string().nullable().optional(),
});
export type MusicBatchJob = z.infer<typeof MusicBatchJobSchema>;

export const MusicPlaylistBatchStatusSchema = z.object({
  batchId: z.string(),
  total: z.number().default(0),
  done: z.number().default(0),
  failed: z.number().default(0),
  jobs: z.array(MusicBatchJobSchema).default([]),
});
export type MusicPlaylistBatchStatus = z.infer<typeof MusicPlaylistBatchStatusSchema>;

// ---------------------------------------------------------------------------
// Ratings: GET /bff/music/ratings, POST /bff/music/ratings
// ---------------------------------------------------------------------------

export const MusicRatingsResponseSchema = z.object({
  ratings: z.record(z.string(), z.number()).default({}),
});
export type MusicRatingsResponse = z.infer<typeof MusicRatingsResponseSchema>;

/** One preview track this user has listened through, tallied by the worker. */
export const MusicPlaySchema = z.object({
  videoId: z.string(),
  count: z.number(),
  title: z.string().default(''),
  artist: z.string().default(''),
  /** Track length in seconds, 0 when it was never known. */
  seconds: z.number().default(0),
});
export type MusicPlay = z.infer<typeof MusicPlaySchema>;

export const MusicPlaysResponseSchema = z.object({
  plays: z.array(MusicPlaySchema).default([]),
});

export const MusicRatingSchema = z.object({
  videoId: z.string(),
  rating: z.number(),
});
export type MusicRating = z.infer<typeof MusicRatingSchema>;
