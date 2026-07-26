import { z } from 'zod';
import { apiFetch } from '../lib/http/client';
import { getSession } from '../lib/session/store';
import { deleteItem } from './jellyfin';
import { JellyfinQueryResultSchema, type JellyfinQueryResult } from './schemas/jellyfin';

// User-created Jellyfin Playlists — the user's own saved lists of songs already
// in the library. Distinct from the "download a YouTube playlist" search cards
// (api/music.ts), which pull NEW audio onto the server. These endpoints were
// verified live against the deployment.
//
// Reads are Zod-validated (JellyfinQueryResultSchema — `PlaylistItemId` rides
// along on playlist-track reads). Writes return 204/{Id} and need no schema.
// `UserId` comes from the stored session, the same place apiFetch reads the
// `X-Emby-Token` from, so callers never have to thread the id through.

const CreatePlaylistResponseSchema = z.object({ Id: z.string() });
export type CreatePlaylistResponse = z.infer<typeof CreatePlaylistResponseSchema>;

/** The logged-in user's Jellyfin id, or throw — every playlist call needs it. */
function requireUserId(): string {
  const userId = getSession()?.jellyfinUserId;
  if (!userId) throw new Error('No Jellyfin session — cannot resolve UserId for playlists');
  return userId;
}

/**
 * Create a new playlist owned by the user. Optionally seed it with one song
 * (`seedId`) so "Crear nueva…" from a song row both creates the list AND adds
 * that song in a single call. Returns the new playlist's `{ Id }`.
 */
export async function createPlaylist(
  name: string,
  seedId?: string,
): Promise<CreatePlaylistResponse> {
  const query = new URLSearchParams({ Name: name, UserId: requireUserId(), MediaType: 'Audio' });
  if (seedId) query.set('Ids', seedId);
  return apiFetch('jellyfin', `/Playlists?${query.toString()}`, {
    method: 'POST',
    schema: CreatePlaylistResponseSchema,
  });
}

/** Append one song to an existing playlist. Resolves on the endpoint's 204. */
export async function addToPlaylist(playlistId: string, songId: string): Promise<void> {
  const query = new URLSearchParams({ Ids: songId, UserId: requireUserId() });
  await apiFetch('jellyfin', `/Playlists/${playlistId}/Items?${query.toString()}`, {
    method: 'POST',
  });
}

/** The user's own playlists (Playlist items), alphabetically. */
export async function getUserPlaylists(): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams({
    IncludeItemTypes: 'Playlist',
    Recursive: 'true',
    SortBy: 'SortName',
  });
  return apiFetch('jellyfin', `/Users/${requireUserId()}/Items?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * A playlist's tracks, in playlist order. Each entry carries a `PlaylistItemId`
 * (its membership id) alongside the usual Audio fields — that id is what
 * `removeFromPlaylist` targets.
 */
export async function getPlaylistTracks(playlistId: string): Promise<JellyfinQueryResult> {
  const query = new URLSearchParams({ UserId: requireUserId() });
  return apiFetch('jellyfin', `/Playlists/${playlistId}/Items?${query.toString()}`, {
    schema: JellyfinQueryResultSchema,
  });
}

/**
 * Remove one track from a playlist by its membership id (`PlaylistItemId`, from
 * `getPlaylistTracks`), not the song's item id — the same song may appear more
 * than once. Resolves on the endpoint's 204.
 */
export async function removeFromPlaylist(playlistId: string, entryId: string): Promise<void> {
  const query = new URLSearchParams({ EntryIds: entryId });
  await apiFetch('jellyfin', `/Playlists/${playlistId}/Items?${query.toString()}`, {
    method: 'DELETE',
  });
}

/** Delete an entire playlist (`DELETE /Items/{id}`). Resolves on the 204. */
export async function deletePlaylist(playlistId: string): Promise<void> {
  await apiFetch('jellyfin', `/Items/${playlistId}`, { method: 'DELETE' });
}

/**
 * Delete a playlist AND every song in it from the library — files included —
 * for wiping a whole downloaded collection, not just the list wrapper. The
 * songs (`trackItemIds`, the Audio `Id`s the caller already holds from
 * `getPlaylistTracks`) go first via `deleteItem`, then the playlist itself.
 *
 * `deleteItem` deletes the underlying file, so this is irreversible — callers
 * must confirm before invoking. Track deletes run with `allSettled` so one
 * failure (e.g. a file already gone) never blocks the rest, and the playlist is
 * always removed at the end regardless. Ids are de-duped: the same song can sit
 * in a list twice but maps to a single library file.
 */
export async function deletePlaylistWithTracks(
  playlistId: string,
  trackItemIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(trackItemIds.filter(Boolean))];
  await Promise.allSettled(uniqueIds.map((itemId) => deleteItem(itemId)));
  await deletePlaylist(playlistId);
}
