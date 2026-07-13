import { apiFetch } from '../lib/http/client';
import { ProwlarrSearchResponseSchema, type ProwlarrRelease } from './schemas/prowlarr';

// Prowlarr client — powers the pre-download availability preview.
//
// Prowlarr is the right backend for "what's out there BEFORE I request it":
// unlike Sonarr/Radarr's interactive search (which needs the title already
// added to get a movieId/seriesId), Prowlarr searches every configured indexer
// for an arbitrary query. The browser never holds Prowlarr's API key — the
// same-origin proxy (Caddy in prod, Vite in dev) injects `X-Api-Key`, exactly
// like the Jellyfin/Jellyseerr prefixes.

/**
 * Full-text manual search across all Prowlarr indexers.
 *
 * `query` is percent-encoded via `encodeURIComponent` (multi-word titles like
 * "Mr Robot" otherwise break the query string). `type=search` is the generic
 * mode that works for both movie and TV titles.
 */
export async function searchReleases(query: string): Promise<ProwlarrRelease[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return apiFetch('prowlarr', `/api/v1/search?query=${encodeURIComponent(trimmed)}&type=search`, {
    schema: ProwlarrSearchResponseSchema,
  });
}

// --- +18 / adult (projector-feature-map.md §3 "+18 / adult section",
// `data/remote/ArrConfig.kt` + `ProwlarrApi.kt`) ---------------------------
//
// TMDB/Jellyseerr never indexes hentai, so +18 discovery goes straight to
// Prowlarr's configured indexers instead of Jellyseerr's discover/search.

/** Adult indexer ids on this Prowlarr instance (`ArrConfig.kt`'s `ADULT_INDEXER_IDS`). */
export const ADULT_INDEXER_IDS: number[] = [23, 16];

/** Default browse query backing the +18 discover row (`ArrConfig.kt`'s `ADULT_BROWSE_QUERY`). */
export const ADULT_BROWSE_QUERY = 'hentai';

/**
 * Adult-scoped manual search, restricted to `indexerIds` (unlike
 * {@link searchReleases}, which searches every configured indexer). Mirrors
 * `ProwlarrApi.kt`'s `search(query, indexerIds)` - Retrofit's `@Query List<Int>`
 * becomes one repeated `indexerIds` query param per id.
 */
export async function searchAdult(query: string, indexerIds: number[]): Promise<ProwlarrRelease[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const params = new URLSearchParams({ query: trimmed, type: 'search' });
  for (const id of indexerIds) params.append('indexerIds', String(id));

  return apiFetch('prowlarr', `/api/v1/search?${params.toString()}`, {
    schema: ProwlarrSearchResponseSchema,
  });
}

/**
 * Grabs a release into the configured download client ("Pedir" for +18,
 * `ProwlarrApi.kt`'s `grab(apiKey, ProwlarrGrabRequest(guid, indexerId))`).
 * 200/204, no response body worth validating.
 */
export async function grabRelease(guid: string, indexerId: number): Promise<void> {
  await apiFetch('prowlarr', '/api/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guid, indexerId }),
  });
}
