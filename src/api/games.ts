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
