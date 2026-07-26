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

// A lightweight {Id, Name} reference. Jellyfin returns these for an Audio
// item's credited artists (`ArtistItems`), each carrying the `MusicArtist`'s
// own item id so the track detail can link straight to its artist page.
export const JellyfinNameIdSchema = z.object({
  Id: z.string(),
  Name: z.string(),
});
export type JellyfinNameId = z.infer<typeof JellyfinNameIdSchema>;

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
  // Audio-only fields (Música feature): a Jellyfin `Audio` item carries its
  // artist(s)/album directly, so the now-playing bar + library list can label
  // tracks without a second lookup.
  Artists: z.array(z.string()).nullable().optional(),
  AlbumArtist: z.string().nullable().optional(),
  Album: z.string().nullable().optional(),
  // Linkable ids carried by an `Audio` item: each credited artist as a
  // {Id,Name} pair (first entry -> artist page) and the parent album's item id
  // (-> album page). Used by the track detail screen (/musica/track/:id).
  ArtistItems: z.array(JellyfinNameIdSchema).nullable().optional(),
  // Album-artist credits, same {Id,Name} shape as `ArtistItems`. A secondary
  // source for the artist-image fallback when a track carries no `ArtistItems`.
  AlbumArtists: z.array(JellyfinNameIdSchema).nullable().optional(),
  AlbumId: z.string().nullable().optional(),
  // The parent album's own Primary image tag. Present means the album HAS a
  // cover — the cover-art fallback chain (resolveCoverUrl) uses it to serve the
  // album's artwork for tracks that lack their own image.
  AlbumPrimaryImageTag: z.string().nullable().optional(),
  // Playlist membership id: only present on items fetched via
  // `/Playlists/{id}/Items`. Each entry's `PlaylistItemId` (NOT its item `Id`)
  // is what removal targets (`DELETE /Playlists/{id}/Items?EntryIds=...`), since
  // the same song can appear in a playlist more than once. Absent everywhere
  // else (library/album/track reads), so it stays optional.
  PlaylistItemId: z.string().nullable().optional(),
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
