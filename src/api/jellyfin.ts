import { apiFetch } from '../lib/http/client';
import { getSession } from '../lib/session/store';
import {
  JellyfinAuthResponseSchema,
  JellyfinItemSchema,
  JellyfinPlaybackInfoResponseSchema,
  JellyfinQueryResultSchema,
  ActivityLogResponseSchema,
  SessionListSchema,
  JellyfinUserListSchema,
  JellyfinUserSchema,
  type ActivityLogResponse,
  type SessionInfo,
  type JellyfinUser,
  type JellyfinAuthResponse,
  type JellyfinItem,
  type JellyfinPlaybackInfoResponse,
  type JellyfinQueryResult,
} from './schemas/jellyfin';

// Jellyfin REST client, ported from `JellyfinApi.kt` (design.md §3.2).

/**
 * Builds the `X-Emby-Authorization` header required by `authenticateByName`.
 * Jellyfin accepts any Client/Device/DeviceId/Version combination as long as
 * the header follows MediaBrowser's auth syntax (`buildEmbyAuthorizationHeader`,
 * JellyfinApi.kt L118-124).
 */
export function buildEmbyAuthorizationHeader(
  deviceId: string,
  deviceName = 'poisonflix-web',
  client = 'poisonflix',
  version = '1.0',
): string {
  return `MediaBrowser Client="${client}", Device="${deviceName}", DeviceId="${deviceId}", Version="${version}"`;
}

export interface AuthenticateByNameParams {
  username: string;
  password: string;
  /** Stable per-browser identifier for the X-Emby-Authorization header. */
  deviceId: string;
}

export async function authenticateByName({
  username,
  password,
  deviceId,
}: AuthenticateByNameParams): Promise<JellyfinAuthResponse> {
  return apiFetch('jellyfin', '/Users/AuthenticateByName', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': buildEmbyAuthorizationHeader(deviceId),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    schema: JellyfinAuthResponseSchema,
  });
}

export interface GetItemsParams {
  sortBy?: string;
  sortOrder?: string;
  includeItemTypes?: string;
  recursive?: boolean;
  limit?: number;
  startIndex?: number;
  searchTerm?: string;
  genres?: string;
  parentId?: string;
  // Música browse (Slice 3): filter albums/tracks by their album artist. Maps
  // to Jellyfin's `AlbumArtistIds`, the reliable way to list a `MusicArtist`'s
  // albums (artists aren't folder parents, so `ParentId` doesn't cover them).
  albumArtistIds?: string;
  fields?: string;
}

export async function getItems(userId: string, params: GetItemsParams = {}): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams();
  query.set('SortBy', params.sortBy ?? 'DateCreated');
  query.set('SortOrder', params.sortOrder ?? 'Descending');
  if (params.includeItemTypes) query.set('IncludeItemTypes', params.includeItemTypes);
  query.set('Recursive', String(params.recursive ?? true));
  if (params.limit != null) query.set('Limit', String(params.limit));
  if (params.startIndex != null) query.set('StartIndex', String(params.startIndex));
  if (params.searchTerm) query.set('SearchTerm', params.searchTerm);
  if (params.genres) query.set('Genres', params.genres);
  if (params.parentId) query.set('ParentId', params.parentId);
  if (params.albumArtistIds) query.set('AlbumArtistIds', params.albumArtistIds);
  query.set('Fields', params.fields ?? 'ProviderIds,MediaStreams');

  return apiFetch('jellyfin', `/Users/${userId}/Items?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * The user's top-level libraries (`Users/{id}/Views`). Used to locate the
 * PIN-gated "Adultos" library so its Movie/Series never leak into the
 * mainstream library row (mirrors MediaRepositoryImpl.kt's `resolveViews`).
 */
export async function getUserViews(userId: string): Promise<JellyfinQueryResult> {
  return apiFetch('jellyfin', `/Users/${userId}/Views`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * Delete a library item and its files (`DELETE /Items/{id}`). Used for +18
 * titles, which have no TMDB id / Radarr/Sonarr record and so can only be
 * removed straight through Jellyfin (projector-feature-map.md §9). 204, no body.
 */
export async function deleteItem(itemId: string): Promise<void> {
  await apiFetch('jellyfin', `/Items/${itemId}`, { method: 'DELETE' });
}

/**
 * Add or remove a library item from the user's Jellyfin favorites
 * (`POST|DELETE /Users/{userId}/FavoriteItems/{itemId}`). UserId comes from the
 * stored session, like the playlist writes, so callers pass only the item.
 */
export async function setFavorite(itemId: string, favorite: boolean): Promise<void> {
  const userId = getSession()?.jellyfinUserId;
  if (!userId) throw new Error('No Jellyfin session — cannot set favorite');
  await apiFetch('jellyfin', `/Users/${userId}/FavoriteItems/${itemId}`, {
    method: favorite ? 'POST' : 'DELETE',
  });
}

export interface GetResumeItemsParams {
  limit?: number;
  mediaTypes?: string;
  includeItemTypes?: string;
  recursive?: boolean;
  fields?: string;
  enableImageTypes?: string;
}

/**
 * "Continuar viendo" row source (Home's Continue Watching row, via
 * `useResumeRow`). Returns the raw Jellyfin resume feed across every readable
 * library; the +18 "Adultos" library is filtered out downstream in
 * `useResumeRow` (same PIN-gate exclusion as `useLibraryRow`).
 */
export async function getResumeItems(
  userId: string,
  params: GetResumeItemsParams = {},
): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set('Limit', String(params.limit));
  query.set('MediaTypes', params.mediaTypes ?? 'Video');
  query.set('IncludeItemTypes', params.includeItemTypes ?? 'Movie,Episode');
  query.set('Recursive', String(params.recursive ?? true));
  query.set('Fields', params.fields ?? 'ProviderIds,UserData');
  query.set('EnableImageTypes', params.enableImageTypes ?? 'Primary');

  return apiFetch('jellyfin', `/Users/${userId}/Items/Resume?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * Jellyfin's activity log — the per-user playback timeline behind the usage
 * monitor. Admin-only on the server side; the caller's own token is what
 * authorises it, so a non-admin session gets a 403 rather than someone else's
 * data. `minDate` is an ISO timestamp; the log is rolling, so an older window
 * simply returns whatever survived.
 */
export async function getActivityEntries(params: {
  limit?: number;
  minDate?: string;
} = {}): Promise<ActivityLogResponse> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 200) });
  if (params.minDate) query.set('minDate', params.minDate);
  return apiFetch('jellyfin', `/System/ActivityLog/Entries?${query.toString()}`, {
    schema: ActivityLogResponseSchema,
  });
}

/** Who is connected right now, and what they have open. Admin-only. */
export async function getActiveSessions(): Promise<SessionInfo[]> {
  return apiFetch('jellyfin', '/Sessions', { schema: SessionListSchema });
}

/** Id -> name for the users the activity log refers to. Admin-only. */
export async function getJellyfinUsers(): Promise<JellyfinUser[]> {
  return apiFetch('jellyfin', '/Users', { schema: JellyfinUserListSchema });
}

export interface PlayedAudioParams {
  limit?: number;
  /** `DatePlayed` = what they just listened to; `PlayCount` = what they keep
   * coming back to. The feed uses both: recency for "Escuchar de nuevo",
   * frequency for the mixes. */
  sortBy?: 'DatePlayed' | 'PlayCount';
}

/**
 * This user's played `Audio` items — the raw taste profile behind Música's
 * personalised feed. It is per user by construction: Jellyfin scopes UserData
 * (PlayCount / LastPlayedDate / IsFavorite) to the requesting user, so two
 * accounts on the same server never see each other's history.
 */
export async function getPlayedAudio(
  userId: string,
  params: PlayedAudioParams = {},
): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    Filters: 'IsPlayed',
    SortBy: params.sortBy ?? 'DatePlayed',
    SortOrder: 'Descending',
    Limit: String(params.limit ?? 40),
    Fields: 'UserData',
    EnableImageTypes: 'Primary',
  });
  return apiFetch('jellyfin', `/Users/${userId}/Items?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * A random spread of this user's own `Audio` library, used to seed the feed
 * before they have listened to anything. Owning a track is a real signal —
 * weaker than playing it, but far better than the worker's global fallback,
 * which seeds off whatever was downloaded to the server last and therefore
 * shows every user the same thing.
 *
 * Random rather than newest: the most recent downloads are one session's worth
 * of one mood, which is exactly the bias that made the generic feed useless.
 */
export async function getRandomLibraryAudio(
  userId: string,
  limit = 30,
): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    SortBy: 'Random',
    Limit: String(limit),
    Fields: 'UserData',
    EnableImageTypes: 'Primary',
  });
  return apiFetch('jellyfin', `/Users/${userId}/Items?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * The same played-history query, with the item runtime included so listening
 * time can be estimated. Kept separate from `getPlayedAudio` so the feed (which
 * needs neither runtime nor genres) doesn't pay for the extra fields.
 */
export async function getPlayedAudioWithRuntime(
  userId: string,
  limit = 200,
): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    Filters: 'IsPlayed',
    SortBy: 'PlayCount',
    SortOrder: 'Descending',
    Limit: String(limit),
    Fields: 'UserData,RunTimeTicks',
    EnableImageTypes: 'Primary',
  });
  return apiFetch('jellyfin', `/Users/${userId}/Items?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * Per-call transport overrides, for the callers that cannot rely on the
 * session store.
 *
 * Only `/cast/:id` uses this today: a television opens that page with the
 * token in its URL and no session anywhere. Kept as a separate trailing
 * argument rather than folded into each endpoint's body/params, because it
 * describes HOW the call is authenticated, not WHAT is being asked for.
 */
export interface JellyfinCallOptions {
  /** Overrides the session store's token for this one request. */
  authToken?: string;
}

/**
 * The user the given token belongs to (`GET /Users/Me`).
 *
 * The cast route needs a user id - every item/playback endpoint below is
 * scoped to one - and it deliberately does NOT carry that id in the URL
 * alongside the token: a token already identifies its user, and two values
 * that must agree are two values that can disagree.
 */
export async function getCurrentUser(options: JellyfinCallOptions = {}): Promise<JellyfinUser> {
  return apiFetch('jellyfin', '/Users/Me', {
    schema: JellyfinUserSchema,
    authToken: options.authToken,
  });
}

export async function getItem(
  userId: string,
  itemId: string,
  fields = 'ProviderIds,MediaStreams',
  options: JellyfinCallOptions = {},
): Promise<JellyfinItem> {
  const query = new URLSearchParams({ Fields: fields });
  return apiFetch('jellyfin', `/Users/${userId}/Items/${itemId}?${query.toString()}`, {
    schema: JellyfinItemSchema,
    authToken: options.authToken,
  });
}

export interface GetPlaybackInfoBody {
  userId: string;
  deviceProfile?: unknown;
  /** Pins the re-resolve to the MediaSource already playing (its `Id`, e.g.
   * `resolvePlayback`'s `mediaSourceId`). Required for `audioStreamIndex`/
   * `subtitleStreamIndex` to have any effect at all on a re-resolve: verified
   * live against a real Jellyfin server (v10.11.11,
   * `MediaInfoHelper.SetDeviceSpecificData`, ~L206-211) - without a
   * `MediaSourceId` that matches a real `MediaSource` on the item, the server
   * silently ignores BOTH stream-index fields and falls back to the file's
   * own default audio/subtitle, no matter what was requested. Omitted on the
   * INITIAL resolve (`usePlaybackInfo`), where there is no prior
   * `MediaSourceId` to pin yet and the server's own default is exactly what's
   * wanted. */
  mediaSourceId?: string;
  audioStreamIndex?: number;
  /** Which subtitle stream the server should deliver (burned in, embedded,
   * external, or as an HLS rendition - the server decides HOW per its own
   * device-profile logic; this only picks WHICH). `-1` explicitly requests
   * "none" (Jellyfin convention, verified against jellyfin/jellyfin
   * v10.11.11's `StreamBuilder`: an explicit `-1` is a real, non-null value
   * that skips the file's-own-default fallback, unlike simply omitting this
   * field). Omitted entirely -> the server picks its own default subtitle
   * (today's behavior for the initial `usePlaybackInfo` resolve). */
  subtitleStreamIndex?: number;
}

export async function getPlaybackInfo(
  itemId: string,
  body: GetPlaybackInfoBody,
  options: JellyfinCallOptions = {},
): Promise<JellyfinPlaybackInfoResponse> {
  return apiFetch('jellyfin', `/Items/${itemId}/PlaybackInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    authToken: options.authToken,
    body: JSON.stringify({
      UserId: body.userId,
      DeviceProfile: body.deviceProfile ?? null,
      MediaSourceId: body.mediaSourceId,
      AudioStreamIndex: body.audioStreamIndex,
      SubtitleStreamIndex: body.subtitleStreamIndex,
    }),
    schema: JellyfinPlaybackInfoResponseSchema,
  });
}

export interface ReportPlayingBody {
  itemId: string;
  playSessionId: string | null;
  playMethod: string;
  positionTicks?: number;
}

export interface ReportProgressBody extends ReportPlayingBody {
  isPaused?: boolean;
}

export interface ReportStoppedBody {
  itemId: string;
  playSessionId: string | null;
  positionTicks: number;
}

// Sessions/Playing*: confirmed live (native reference) to return 204 No
// Content on success - apiFetch resolves those to `undefined`.

export async function reportPlaying(body: ReportPlayingBody): Promise<void> {
  await apiFetch('jellyfin', '/Sessions/Playing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ItemId: body.itemId,
      PlaySessionId: body.playSessionId,
      PlayMethod: body.playMethod,
      PositionTicks: body.positionTicks ?? 0,
    }),
  });
}

export async function reportProgress(body: ReportProgressBody): Promise<void> {
  await apiFetch('jellyfin', '/Sessions/Playing/Progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ItemId: body.itemId,
      PlaySessionId: body.playSessionId,
      PlayMethod: body.playMethod,
      PositionTicks: body.positionTicks ?? 0,
      IsPaused: body.isPaused ?? false,
    }),
  });
}

export async function reportStopped(body: ReportStoppedBody): Promise<void> {
  await apiFetch('jellyfin', '/Sessions/Playing/Stopped', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ItemId: body.itemId,
      PlaySessionId: body.playSessionId,
      PositionTicks: body.positionTicks,
    }),
  });
}
