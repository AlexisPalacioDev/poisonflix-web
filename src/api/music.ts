import { apiFetch } from '../lib/http/client';
import {
  MusicSearchResponseSchema,
  MusicRecommendationsResponseSchema,
  MusicDownloadResponseSchema,
  MusicJobSchema,
  MusicPlaylistBatchSchema,
  MusicPlaylistBatchStatusSchema,
  MusicPlaysResponseSchema,
  MusicRatingsResponseSchema,
  MusicRatingSchema,
  type MusicResultItem,
  type MusicSource,
  type MusicDownloadResponse,
  type MusicJob,
  type MusicPlaylistBatch,
  type MusicPlaylistBatchStatus,
  type MusicRating,
  type MusicRatingsResponse,
  type MusicPlay,
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
//
// `opts.pure` (mobile-music-overhaul: fix-seeded-rows) asks the worker to
// restrict the mix to sources that depend on the seed itself (its own
// autoplay queue plus "related"), dropping the three sources that depend
// only on the signed-in user (their top artists, their likes, their play
// history). Those three are identical for every seed the same user has, so
// without this flag every "Porque escuchaste X" row on the personal feed
// converged on the same handful of tracks — the reported bug. Omitted (the
// default for every OTHER caller, notably `useAutoplayRadio`'s "Mix para
// vos"), the worker keeps mixing in all five sources exactly as before.
export async function getRadio(
  seed: RadioSeed,
  limit = 15,
  opts?: { pure?: boolean },
): Promise<MusicResultItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if ('videoId' in seed) params.set('seed', seed.videoId);
  else params.set('itemId', seed.itemId);
  if (opts?.pure) params.set('pure', '1');
  const { results } = await apiFetch('bff', `/music/recommendations?${params.toString()}`, {
    schema: MusicRecommendationsResponseSchema,
  });
  return results;
}

/** Thumb value: 1 up, -1 down, 0 clears the vote. */
export type RatingValue = 1 | -1 | 0;

/**
 * This user's votes, plus the liked tracks as renderable rows.
 *
 * Both come from one request because they are one thing: `ratings` answers "is
 * this thumb filled?" for a row already on screen, `liked` answers "what have I
 * liked?" for the screen that lists them.
 */
export async function getRatings(): Promise<MusicRatingsResponse> {
  return apiFetch('bff', '/music/ratings', {
    schema: MusicRatingsResponseSchema,
  });
}

/**
 * Casts (or clears) a thumb.
 *
 * Neither thumb is cosmetic any more. A thumb-down drops that videoId from
 * every radio the worker builds for this user; a thumb-up becomes one of the
 * seeds those radios are built FROM, and lands in "Tus me gusta".
 *
 * The track's title and artist ride along because the worker stores them beside
 * the vote — it is the only moment we know them, and re-resolving a videoId
 * later would mean a YouTube round trip per liked row.
 */
export async function setTrackRating(
  videoId: string,
  rating: RatingValue,
  meta?: { title?: string | null; artist?: string | null; thumbnailUrl?: string | null },
): Promise<MusicRating> {
  return apiFetch('bff', '/music/ratings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId,
      rating,
      title: meta?.title ?? undefined,
      artist: meta?.artist ?? undefined,
      thumbnailUrl: meta?.thumbnailUrl ?? undefined,
    }),
    schema: MusicRatingSchema,
  });
}

/**
 * Preview listens for this user, tallied by videoId.
 *
 * Jellyfin owns history for library items, but a preview has no Jellyfin item
 * to bump a PlayCount on, so the worker keeps this second tally. Both are
 * merged when the stats are built - neither alone is the user's listening.
 */
export async function getPreviewPlays(): Promise<MusicPlay[]> {
  const { plays } = await apiFetch('bff', '/music/plays', {
    schema: MusicPlaysResponseSchema,
  });
  return plays;
}

/** Counts one preview listened through. Metadata rides along because a bare
 * videoId is not renderable and re-resolving it later costs a YouTube call. */
export async function reportPreviewPlay(input: {
  videoId: string;
  title?: string;
  artist?: string;
  seconds?: number;
}): Promise<void> {
  await apiFetch('bff', '/music/plays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// What identifies a collection to the worker.
export type CollectionRef = { browseId: string } | { playlistId: string };

/**
 * The tracks inside an album or playlist, without downloading any of them.
 *
 * A collection is only an id: it cannot be streamed, but the videoIds inside it
 * can. Resolving that list is what lets "Reproducir" and "Agregar a la cola"
 * exist on a collection card at all, reusing the same per-track stream proxy a
 * single search hit uses.
 */
export async function getCollectionTracks(
  ref: CollectionRef,
  limit = 200,
): Promise<MusicResultItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if ('browseId' in ref) params.set('browseId', ref.browseId);
  else params.set('playlistId', ref.playlistId);
  const { results } = await apiFetch('bff', `/music/collection?${params.toString()}`, {
    schema: MusicSearchResponseSchema,
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

// ---------------------------------------------------------------------------
// Cache warming: POST /bff/music/warm
// ---------------------------------------------------------------------------

/**
 * How much of the worker's pipeline to run ahead of time.
 *
 * Measured against the live worker (mobile-music-overhaul): resolving the
 * playable URL is 2.324s of the 2.758s a cold `play()` waits on — 'url' pays
 * that alone and is cheap enough to fire for a whole page of search results.
 * 'full' also downloads + runs ffmpeg, which is the rest of the wait; it's
 * only worth paying for a track that's almost certainly about to play.
 */
export type MusicWarmDepth = 'url' | 'full';

/**
 * A search hit's `source` field is a loosely-typed string straight off the
 * worker (see `MusicSearchResult.source`), not the strict `MusicSource` the
 * warm/search endpoints take. Mirrors `previewStreamUrl`'s own fallback:
 * anything other than the two explicit values becomes 'auto', which is also
 * the worker's own default when the param is left out.
 */
export function normalizeMusicSource(source?: string | null): MusicSource {
  return source === 'ytmusic' || source === 'youtube' ? source : 'auto';
}

// Per-tab dedup: don't ask the worker to warm the same videoId at the same
// depth for the same source twice in one session. Source is part of the key,
// not just videoId+depth, because callers now forward the real source
// instead of always 'auto' (e.g. the queue's next-track warm reads it off
// the track's own streamUrl — see MusicPlayerProvider) — a call for the same
// videoId+depth but a different source is a genuinely different request from
// this client's point of view, and this dedup must not be the one to drop it.
//
// This only closes the client-side half of the problem. The worker's own
// `_stream_cache` and `_warm_inflight` bookkeeping (infra/music-worker/
// server.py) are still keyed on videoId alone, with no source in the key —
// so if a wrong-source warm reaches the worker first and seeds its cache, a
// later correct-source warm for that same videoId can still short-circuit
// there as "already warm" without ever running its own resolve. Making the
// worker's cache source-aware is a separate, larger change; this key only
// guarantees the client itself won't be the one throwing the request away.
//
// A 204 (already warm), 202 (already warming) and even a failed request all
// mean "no point asking again for this exact key" from here — a retry buys
// nothing and the eventual play still falls back to its normal (unwarmed)
// cost either way. Never cleared: there's no event that makes a prior warm
// stop being useful information.
const warmedKeys = new Set<string>();

/**
 * Fire-and-forget: ask the worker to get `videoId` ready before the user taps
 * play (see the file-level measurement above). This must never affect
 * playback — a warm that never lands, lands late, or the endpoint being down
 * entirely all degrade to exactly what happens today: the real play pays the
 * unwarmed cost. Callers must not await this for anything user-visible.
 */
export function warmMusicTrack(videoId: string, source: MusicSource, depth: MusicWarmDepth): void {
  const key = `${depth}:${source}:${videoId}`;
  if (warmedKeys.has(key)) return;
  warmedKeys.add(key);
  void apiFetch('bff', '/music/warm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, source, depth }),
  }).catch(() => {
    // Best-effort, per the docstring above: nothing to do or report. The
    // worst case is the track loads exactly as slowly as it would have
    // without ever calling this.
  });
}
