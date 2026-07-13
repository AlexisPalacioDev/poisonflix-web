import { apiFetch } from '../lib/http/client';
import {
  JellyfinAuthResponseSchema,
  JellyfinItemSchema,
  JellyfinPlaybackInfoResponseSchema,
  JellyfinQueryResultSchema,
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
  searchTerm?: string;
  genres?: string;
  parentId?: string;
  fields?: string;
}

export async function getItems(userId: string, params: GetItemsParams = {}): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams();
  query.set('SortBy', params.sortBy ?? 'DateCreated');
  query.set('SortOrder', params.sortOrder ?? 'Descending');
  if (params.includeItemTypes) query.set('IncludeItemTypes', params.includeItemTypes);
  query.set('Recursive', String(params.recursive ?? true));
  if (params.limit != null) query.set('Limit', String(params.limit));
  if (params.searchTerm) query.set('SearchTerm', params.searchTerm);
  if (params.genres) query.set('Genres', params.genres);
  if (params.parentId) query.set('ParentId', params.parentId);
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

export interface GetResumeItemsParams {
  limit?: number;
  mediaTypes?: string;
  includeItemTypes?: string;
  recursive?: boolean;
  fields?: string;
  enableImageTypes?: string;
}

/**
 * "Continuar viendo" row source - reserved for the deferred Continue Watching
 * row (tasks.md Slice 1, note "deferred"). Signature only; not called from
 * any UI yet.
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

export async function getItem(
  userId: string,
  itemId: string,
  fields = 'ProviderIds,MediaStreams',
): Promise<JellyfinItem> {
  const query = new URLSearchParams({ Fields: fields });
  return apiFetch('jellyfin', `/Users/${userId}/Items/${itemId}?${query.toString()}`, {
    schema: JellyfinItemSchema,
  });
}

export interface GetPlaybackInfoBody {
  userId: string;
  deviceProfile?: unknown;
  audioStreamIndex?: number;
}

export async function getPlaybackInfo(
  itemId: string,
  body: GetPlaybackInfoBody,
): Promise<JellyfinPlaybackInfoResponse> {
  return apiFetch('jellyfin', `/Items/${itemId}/PlaybackInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      UserId: body.userId,
      DeviceProfile: body.deviceProfile ?? null,
      AudioStreamIndex: body.audioStreamIndex,
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
