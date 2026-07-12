import { z } from 'zod';

// Jellyseerr REST schemas, ported from the Kotlin reference's
// `JellyseerrDto.kt`. Status enum (confirmed live against a real instance):
// 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIALLY_AVAILABLE, 5=AVAILABLE.

// ---------------------------------------------------------------------------
// Auth: POST /api/v1/auth/jellyfin
// ---------------------------------------------------------------------------

export const JellyseerrUserSchema = z.object({
  id: z.number(),
  email: z.string().nullable().optional(),
  jellyfinUsername: z.string().nullable().optional(),
  jellyfinUserId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  permissions: z.number().default(0),
});
export type JellyseerrUser = z.infer<typeof JellyseerrUserSchema>;

// ---------------------------------------------------------------------------
// Media status - embedded in search results' `mediaInfo`, and a request's
// `media`.
// ---------------------------------------------------------------------------

export const JellyseerrMediaInfoSchema = z.object({
  id: z.number(),
  tmdbId: z.number().nullable().optional(),
  tvdbId: z.number().nullable().optional(),
  mediaType: z.string().nullable().optional(),
  status: z.number(),
  status4k: z.number().nullable().optional(),
  serviceUrl: z.string().nullable().optional(),
  jellyfinMediaId: z.string().nullable().optional(),
});
export type JellyseerrMediaInfo = z.infer<typeof JellyseerrMediaInfoSchema>;

// ---------------------------------------------------------------------------
// Search: GET /api/v1/search, GET /api/v1/discover/trending|movies|tv
// (same response envelope shape across all four).
// ---------------------------------------------------------------------------

export const JellyseerrSearchResultSchema = z.object({
  id: z.number(),
  // "movie" | "tv" | "person" - non-movie/tv entries are filtered by callers.
  mediaType: z.string(),
  title: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  releaseDate: z.string().nullable().optional(),
  firstAirDate: z.string().nullable().optional(),
  overview: z.string().nullable().optional(),
  posterPath: z.string().nullable().optional(),
  backdropPath: z.string().nullable().optional(),
  voteAverage: z.number().nullable().optional(),
  adult: z.boolean().default(false),
  genreIds: z.array(z.number()).default([]),
  mediaInfo: JellyseerrMediaInfoSchema.nullable().optional(),
});
export type JellyseerrSearchResult = z.infer<typeof JellyseerrSearchResultSchema>;

export const JellyseerrSearchResponseSchema = z.object({
  page: z.number().default(1),
  totalPages: z.number().default(0),
  totalResults: z.number().default(0),
  results: z.array(JellyseerrSearchResultSchema).default([]),
});
export type JellyseerrSearchResponse = z.infer<typeof JellyseerrSearchResponseSchema>;

// ---------------------------------------------------------------------------
// Movie details: GET /api/v1/movie/{tmdbId} - detail screen (detail-request
// spec). Same envelope family as the search-result schema above, plus the
// field the detail screen needs that a search-result summary doesn't carry
// (`backdropPath` for the hero image). `title` is non-optional here (unlike
// the search-result schema's movie/tv union) since this endpoint is
// movie-only (TV two-pane detail is deferred per the detail-request spec).
// ---------------------------------------------------------------------------

export const JellyseerrMovieDetailsSchema = z.object({
  id: z.number(),
  title: z.string(),
  overview: z.string().nullable().optional(),
  releaseDate: z.string().nullable().optional(),
  posterPath: z.string().nullable().optional(),
  backdropPath: z.string().nullable().optional(),
  voteAverage: z.number().nullable().optional(),
  runtime: z.number().nullable().optional(),
  mediaInfo: JellyseerrMediaInfoSchema.nullable().optional(),
});
export type JellyseerrMovieDetails = z.infer<typeof JellyseerrMovieDetailsSchema>;

// ---------------------------------------------------------------------------
// Request creation/listing: POST /api/v1/request, GET /api/v1/request
// ---------------------------------------------------------------------------

export const JellyseerrRequestDtoSchema = z.object({
  id: z.number(),
  type: z.string(),
  status: z.number(),
  media: JellyseerrMediaInfoSchema,
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});
export type JellyseerrRequestDto = z.infer<typeof JellyseerrRequestDtoSchema>;

export const JellyseerrPageInfoSchema = z.object({
  pages: z.number().default(0),
  pageSize: z.number().default(0),
  results: z.number().default(0),
  page: z.number().default(0),
});
export type JellyseerrPageInfo = z.infer<typeof JellyseerrPageInfoSchema>;

export const JellyseerrRequestListResponseSchema = z.object({
  pageInfo: JellyseerrPageInfoSchema.nullable().optional(),
  results: z.array(JellyseerrRequestDtoSchema).default([]),
});
export type JellyseerrRequestListResponse = z.infer<typeof JellyseerrRequestListResponseSchema>;
