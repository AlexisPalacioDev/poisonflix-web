import { apiFetch } from '../lib/http/client';
import {
  MusicSearchResponseSchema,
  MusicRecommendationsResponseSchema,
  MusicDownloadResponseSchema,
  MusicJobSchema,
  MusicPlaylistBatchSchema,
  MusicPlaylistBatchStatusSchema,
  type MusicResultItem,
  type MusicSource,
  type MusicDownloadResponse,
  type MusicJob,
  type MusicPlaylistBatch,
  type MusicPlaylistBatchStatus,
} from './schemas/music';

// Música client. Every call goes through `apiFetch('bff', '/music/...')`, which
// sends the same `connect.sid` cookie as the rest of the BFF-fronted backends —
// the BFF authenticates against that session, then thin-proxies to the internal
// poisonflix-music-worker (which alone holds the Jellyfin music key). No worker
// credential ever reaches the browser.

export async function searchMusic(
  query: string,
  source: MusicSource = 'auto',
  limit = 20,
): Promise<MusicResultItem[]> {
  const params = new URLSearchParams({ q: query, source, limit: String(limit) });
  const { results } = await apiFetch('bff', `/music/search?${params.toString()}`, {
    schema: MusicSearchResponseSchema,
  });
  return results;
}

// "Recomendados para ti": the worker's suggestion feed. `seed` biases it toward
// a track/artist the user just played; omitted, the worker returns a general
// mix. Returns the same `song` shape as search, so results are directly
// playable/downloadable through the existing per-result flow.
export async function getRecommendations(
  seed?: string,
  limit = 12,
): Promise<MusicResultItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (seed) params.set('seed', seed);
  const { results } = await apiFetch('bff', `/music/recommendations?${params.toString()}`, {
    schema: MusicRecommendationsResponseSchema,
  });
  return results;
}

// What a radio is seeded from. A search hit knows its `videoId`; a library /
// album / playlist track only knows its Jellyfin `itemId`, which the worker
// reverses back to the videoId the file was downloaded from.
export type RadioSeed = { videoId: string } | { itemId: string };

// The endless-radio feed behind autoplay: related tracks for whatever is
// playing, so a queue never just stops. Same endpoint (and same `song` shape)
// as the recommendations rail — only the seed differs.
export async function getRadio(seed: RadioSeed, limit = 15): Promise<MusicResultItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if ('videoId' in seed) params.set('seed', seed.videoId);
  else params.set('itemId', seed.itemId);
  const { results } = await apiFetch('bff', `/music/recommendations?${params.toString()}`, {
    schema: MusicRecommendationsResponseSchema,
  });
  return results;
}

// Kicks off a whole-collection download. The worker accepts a YT Music playlist
// id, an album `browseId`, or a raw playlist URL — reached from the search /
// recommendation collection cards. Returns a batch handle (202 Accepted) whose
// progress is polled via `getPlaylistBatch`.
export type PlaylistRequest = { playlistId: string } | { browseId: string } | { url: string };

export async function requestPlaylist(request: PlaylistRequest): Promise<MusicPlaylistBatch> {
  return apiFetch('bff', '/music/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    schema: MusicPlaylistBatchSchema,
  });
}

// Thin per-case wrappers used by the collection cards.
export const downloadPlaylist = (playlistId: string): Promise<MusicPlaylistBatch> =>
  requestPlaylist({ playlistId });

export const downloadAlbum = (browseId: string): Promise<MusicPlaylistBatch> =>
  requestPlaylist({ browseId });

export async function getPlaylistBatch(batchId: string): Promise<MusicPlaylistBatchStatus> {
  return apiFetch('bff', `/music/playlists/${encodeURIComponent(batchId)}`, {
    schema: MusicPlaylistBatchStatusSchema,
  });
}

export interface RequestDownloadParams {
  videoId: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
}

export async function requestDownload(params: RequestDownloadParams): Promise<MusicDownloadResponse> {
  return apiFetch('bff', '/music/downloads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    schema: MusicDownloadResponseSchema,
  });
}

export async function getMusicJob(jobId: string): Promise<MusicJob> {
  return apiFetch('bff', `/music/downloads/${encodeURIComponent(jobId)}`, {
    schema: MusicJobSchema,
  });
}
