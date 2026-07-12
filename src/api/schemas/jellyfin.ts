import { z } from 'zod';

// Jellyfin REST schemas, ported from the Kotlin reference's `JellyfinDto.kt`
// (data/remote/dto). Only fields the web client actually consumes are
// declared; unknown fields are ignored by zod's default (non-strict) object
// parsing, mirroring the Kotlin `ignoreUnknownKeys = true` Json config.

// ---------------------------------------------------------------------------
// Auth: POST /Users/AuthenticateByName
// ---------------------------------------------------------------------------

export const JellyfinUserSchema = z.object({
  Id: z.string(),
  Name: z.string(),
});
export type JellyfinUser = z.infer<typeof JellyfinUserSchema>;

export const JellyfinAuthResponseSchema = z.object({
  User: JellyfinUserSchema,
  AccessToken: z.string(),
  ServerId: z.string(),
});
export type JellyfinAuthResponse = z.infer<typeof JellyfinAuthResponseSchema>;

// ---------------------------------------------------------------------------
// Views / Items: GET /Users/{userId}/Items, GET /Users/{userId}/Items/{itemId}
// ---------------------------------------------------------------------------

export const JellyfinUserDataSchema = z.object({
  PlaybackPositionTicks: z.number().default(0),
  PlayCount: z.number().default(0),
  Played: z.boolean().default(false),
  IsFavorite: z.boolean().default(false),
});
export type JellyfinUserData = z.infer<typeof JellyfinUserDataSchema>;

export const JellyfinItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string().nullable().optional(),
  // Only present on library/view folders (e.g. "movies", "tvshows").
  CollectionType: z.string().nullable().optional(),
  Overview: z.string().nullable().optional(),
  Genres: z.array(z.string()).nullable().optional(),
  ProductionYear: z.number().nullable().optional(),
  PremiereDate: z.string().nullable().optional(),
  RunTimeTicks: z.number().nullable().optional(),
  CommunityRating: z.number().nullable().optional(),
  OfficialRating: z.string().nullable().optional(),
  // e.g. {"Imdb":"tt0063350","Tmdb":"10331"} - used by LibraryIndex to
  // correlate against Jellyseerr's tmdbId.
  ProviderIds: z.record(z.string(), z.string()).nullable().optional(),
  MediaStreams: z.array(z.unknown()).nullable().optional(),
  UserData: JellyfinUserDataSchema.nullable().optional(),
  ImageTags: z.record(z.string(), z.string()).nullable().optional(),
  BackdropImageTags: z.array(z.string()).nullable().optional(),
  // Episode-only fields.
  IndexNumber: z.number().nullable().optional(),
  ParentIndexNumber: z.number().nullable().optional(),
  SeriesId: z.string().nullable().optional(),
  SeriesName: z.string().nullable().optional(),
  SeriesPrimaryImageTag: z.string().nullable().optional(),
});
export type JellyfinItem = z.infer<typeof JellyfinItemSchema>;

export const JellyfinQueryResultSchema = z.object({
  Items: z.array(JellyfinItemSchema).default([]),
  TotalRecordCount: z.number().default(0),
  StartIndex: z.number().default(0),
});
export type JellyfinQueryResult = z.infer<typeof JellyfinQueryResultSchema>;

// ---------------------------------------------------------------------------
// PlaybackInfo: POST /Items/{itemId}/PlaybackInfo
// ---------------------------------------------------------------------------

export const JellyfinMediaSourceSchema = z.object({
  Id: z.string(),
  Path: z.string().nullable().optional(),
  Container: z.string().nullable().optional(),
  RunTimeTicks: z.number().nullable().optional(),
  SupportsDirectPlay: z.boolean().default(false),
  SupportsDirectStream: z.boolean().default(false),
  SupportsTranscoding: z.boolean().default(false),
  // Non-null here means the server picked transcode/HLS over direct play -
  // this is streamResolver.ts's single decision point (Slice 2/7, not this one).
  TranscodingUrl: z.string().nullable().optional(),
  TranscodingSubProtocol: z.string().nullable().optional(),
  MediaStreams: z.array(z.unknown()).default([]),
  DefaultAudioStreamIndex: z.number().nullable().optional(),
  DefaultSubtitleStreamIndex: z.number().nullable().optional(),
});
export type JellyfinMediaSource = z.infer<typeof JellyfinMediaSourceSchema>;

export const JellyfinPlaybackInfoResponseSchema = z.object({
  MediaSources: z.array(JellyfinMediaSourceSchema).default([]),
  PlaySessionId: z.string().nullable().optional(),
});
export type JellyfinPlaybackInfoResponse = z.infer<typeof JellyfinPlaybackInfoResponseSchema>;
