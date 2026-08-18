import { apiFetch, apiUrl } from '../lib/http/client';
import { GamesLibraryResponseSchema, type Game } from './schemas/games';

// Juegos client. Same shape as the Música client: every call goes through
// `apiFetch('bff', '/games/...')`, which replays the caller's `connect.sid`
// cookie, and the BFF is what actually touches the disk. 'games' is not a
// `Backend` of its own — it is a path under the BFF, exactly like '/music'.

/** Every ROM the server can serve, unfiltered and unpaged: the library is a
 * directory listing, so it arrives whole or not at all. */
export async function getGamesLibrary(): Promise<Game[]> {
  const { games } = await apiFetch('bff', '/games/library', {
    schema: GamesLibraryResponseSchema,
  });
  return games;
}

/**
 * Where the ROM bytes live.
 *
 * A URL rather than a fetch on purpose: EmulatorJS downloads the file itself
 * (with Range requests, so a 40 MB cartridge starts before it has finished
 * arriving) and only accepts a string. Pulling the bytes here would mean
 * holding the whole ROM in JS memory for nothing.
 */
export function romUrl(id: string): string {
  return apiUrl('bff', `/games/rom?id=${encodeURIComponent(id)}`);
}

/**
 * Where a game's box art lives, or would live.
 *
 * A URL for the same reason as `romUrl`: an `<img>` fetches on its own, and it
 * gets lazy loading and the browser's image cache for free — a fetch here would
 * buy a base64 round trip and lose both.
 *
 * The endpoint answers 404 for every game whose folder has no cover, which is
 * most of them. That is a normal answer, not an error: the caller renders a
 * placeholder on the image's `error` event (see `GameCover`).
 */
export function gameCoverUrl(id: string): string {
  return apiUrl('bff', `/games/cover?id=${encodeURIComponent(id)}`);
}
