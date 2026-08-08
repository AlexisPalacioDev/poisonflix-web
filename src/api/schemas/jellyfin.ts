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

// Delivery method Jellyfin used for ONE subtitle stream in THIS specific
// playback session - ported from the server's own
// `MediaBrowser.Model.Dlna.SubtitleDeliveryMethod` enum (verified against
// jellyfin/jellyfin v10.11.11's source, tag-pinned). `Encode` is the one that
// matters for the player's dedup bug fix: it means the server already burned
// the subtitle into the transcoded video's PIXELS
// (`Jellyfin.Api.Helpers.MediaInfoHelper.SetDeviceSpecificSubtitleInfo` sets
// this per-stream), so a client-side `<track>`/hls.js text rendition for that
// SAME stream would show the same text twice. This field is only ever
// populated on a MediaStream returned INSIDE a `PlaybackInfo` response's
// `MediaSources` (that helper mutates the MediaSource's own in-memory copy of
// the stream) - a generic `/Items/{id}` fetch's `MediaStreams` never runs
// that device-profile-specific logic, so `JellyfinItemSchema` deliberately
// keeps `MediaStreams` as `z.array(z.unknown())` (parsed separately + only
// for menu labels by `features/player/mediaStreamTracks.ts`) rather than
// implying a field that would always come back empty there.
export const SubtitleDeliveryMethodSchema = z.enum(['Encode', 'Embed', 'External', 'Hls', 'Drop']);
export type SubtitleDeliveryMethod = z.infer<typeof SubtitleDeliveryMethodSchema>;

// A single entry of `JellyfinMediaSourceSchema.MediaStreams` (Video, Audio,
// Subtitle, or EmbeddedImage - only `Type`/`Index`/`DeliveryMethod` are
// needed here; richer per-kind parsing for menu display already lives in
// `features/player/mediaStreamTracks.ts`'s own `parseMediaStream`, which
// reads the equally-loose `JellyfinItemSchema.MediaStreams` instead).
export const JellyfinMediaStreamSchema = z.object({
  Index: z.number(),
  Type: z.string(),
  Codec: z.string().nullable().optional(),
  Language: z.string().nullable().optional(),
  DisplayTitle: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  IsDefault: z.boolean().default(false),
  IsForced: z.boolean().default(false),
  IsExternal: z.boolean().default(false),
  // Parsed as a plain string ON PURPOSE, even though the meaningful values
  // are the five in `SubtitleDeliveryMethodSchema`. Zod fails a whole array
  // when a SINGLE item fails, and `MediaStreams` nests inside `MediaSources`
  // inside the `PlaybackInfo` response - so validating this as a strict enum
  // meant one subtitle carrying a value the enum never heard of (newer
  // server, fork, undocumented value) failed the entire response, `apiFetch`
  // raised, and the title refused to PLAY AT ALL. Trading playback for a
  // cosmetic field is never the right call.
  //
  // Narrowing to the union happens downstream in `subtitleDeliveryMethodsOf`,
  // which keeps only recognized values - unknown ones simply read as "no
  // delivery method", the same state as before this field existed.
  DeliveryMethod: z.string().nullable().optional(),
});
export type JellyfinMediaStream = z.infer<typeof JellyfinMediaStreamSchema>;

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
  MediaStreams: z.array(JellyfinMediaStreamSchema).default([]),
  DefaultAudioStreamIndex: z.number().nullable().optional(),
  DefaultSubtitleStreamIndex: z.number().nullable().optional(),
});
export type JellyfinMediaSource = z.infer<typeof JellyfinMediaSourceSchema>;

export const JellyfinPlaybackInfoResponseSchema = z.object({
  MediaSources: z.array(JellyfinMediaSourceSchema).default([]),
  PlaySessionId: z.string().nullable().optional(),
});
export type JellyfinPlaybackInfoResponse = z.infer<typeof JellyfinPlaybackInfoResponseSchema>;

// ---------------------------------------------------------------------------
// Usage monitor: Jellyfin's own activity log + live sessions.
//
// The activity log is the only per-user *timeline* the server keeps without a
// plugin — UserData gives totals (PlayCount) but never says when. It is a
// rolling log, so it answers "lately", not "ever"; the monitor says so rather
// than implying a completeness it can't have.
// ---------------------------------------------------------------------------

export const ActivityEntrySchema = z.object({
  Id: z.number(),
  Name: z.string().nullable().optional(),
  // e.g. "AudioPlaybackStopped", "VideoPlaybackStarted", "SessionStarted".
  Type: z.string().nullable().optional(),
  ItemId: z.string().nullable().optional(),
  Date: z.string(),
  UserId: z.string().nullable().optional(),
  Severity: z.string().nullable().optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

export const ActivityLogResponseSchema = z.object({
  Items: z.array(ActivityEntrySchema).default([]),
  TotalRecordCount: z.number().default(0),
});
export type ActivityLogResponse = z.infer<typeof ActivityLogResponseSchema>;

export const SessionInfoSchema = z.object({
  Id: z.string().nullable().optional(),
  UserId: z.string().nullable().optional(),
  UserName: z.string().nullable().optional(),
  Client: z.string().nullable().optional(),
  DeviceName: z.string().nullable().optional(),
  NowPlayingItem: z
    .object({
      Name: z.string().nullable().optional(),
      Type: z.string().nullable().optional(),
      Artists: z.array(z.string()).default([]),
    })
    .nullable()
    .optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionListSchema = z.array(SessionInfoSchema);

// Reuses the JellyfinUserSchema declared at the top of this file — the usage
// monitor only needs id -> name to label the activity log.
export const JellyfinUserListSchema = z.array(JellyfinUserSchema);
