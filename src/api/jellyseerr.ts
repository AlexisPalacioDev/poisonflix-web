import { apiFetch } from '../lib/http/client';
import { tmdbLanguageParam } from '../lib/domain/languageSettings';
import {
  JellyseerrMovieDetailsSchema,
  JellyseerrTvDetailsSchema,
  JellyseerrRequestDtoSchema,
  JellyseerrRequestListResponseSchema,
  JellyseerrSearchResponseSchema,
  JellyseerrUserSchema,
  type JellyseerrMovieDetails,
  type JellyseerrTvDetails,
  type JellyseerrRequestDto,
  type JellyseerrRequestListResponse,
  type JellyseerrSearchResponse,
  type JellyseerrUser,
} from './schemas/jellyseerr';

// Jellyseerr REST client, ported from `JellyseerrApi.kt` (design.md §3.2).

export interface AuthJellyfinParams {
  username: string;
  password: string;
}

/**
 * Body is deliberately `{username, password}` ONLY - sending
 * hostname/port/useSsl/urlBase/serverType against an already-provisioned
 * Jellyseerr instance returns 500 "Jellyfin hostname already configured"
 * (confirmed live, JellyseerrDto.kt's file header). Never add those fields
 * here for the MVP's single pre-provisioned deployment.
 */
export async function authJellyfin({ username, password }: AuthJellyfinParams): Promise<JellyseerrUser> {
  return apiFetch('jellyseerr', '/api/v1/auth/jellyfin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    schema: JellyseerrUserSchema,
  });
}

/**
 * Ends the server-side Jellyseerr session by invalidating its `connect.sid`
 * cookie (Jellyseerr's `POST /api/v1/auth/logout`). Same-origin via the
 * `/jellyseerr` proxy, so `apiFetch`'s `credentials:'include'` replays the
 * cookie for the server to clear. Returns 204/JSON with nothing worth
 * validating. Callers MUST treat this as best-effort: a failure here must not
 * strand the user, so local session teardown proceeds regardless (AuthContext
 * `logout`).
 */
export async function logout(): Promise<void> {
  await apiFetch('jellyseerr', '/api/v1/auth/logout', { method: 'POST' });
}

/**
 * TMDB-backed multi-search; movie/tv results carry an embedded `mediaInfo`
 * once tracked.
 *
 * `query` is percent-encoded via `encodeURIComponent` rather than folded into
 * `URLSearchParams` - confirmed live that Jellyseerr's search endpoint
 * rejects `URLSearchParams`'s `+`-for-space encoding with 400 ("Parameter
 * 'query' must be url encoded"), even though `discover/trending`'s
 * space-free params never exposed this. Multi-word queries (e.g. "Breaking
 * Bad") would otherwise 400 on every keystroke that settles.
 *
 * `language` is read dynamically via `tmdbLanguageParam()` (the header's
 * ES⇄EN toggle) on every call, not captured once at module load.
 */
export async function search(query: string, page = 1): Promise<JellyseerrSearchResponse> {
  const qs = new URLSearchParams({ page: String(page), language: tmdbLanguageParam() });
  return apiFetch('jellyseerr', `/api/v1/search?query=${encodeURIComponent(query)}&${qs.toString()}`, {
    schema: JellyseerrSearchResponseSchema,
  });
}

/**
 * Home's Trending row source - mixed movie/tv trending list. `language` is
 * read dynamically via `tmdbLanguageParam()` (the header's ES⇄EN toggle) on
 * every call.
 */
export async function discoverTrending(page = 1): Promise<JellyseerrSearchResponse> {
  const qs = new URLSearchParams({ page: String(page), language: tmdbLanguageParam() });
  return apiFetch('jellyseerr', `/api/v1/discover/trending?${qs.toString()}`, {
    schema: JellyseerrSearchResponseSchema,
  });
}

export interface DiscoverByGenreParams {
  genre?: number;
  page?: number;
}

/**
 * ADR-4: deliberately NO `language` query param on `discover/movies` -
 * Jellyseerr treats it as a TMDB `with_original_language` CONTENT filter
 * there (unlike `discover/trending`/`search`), and `es-MX` (not an
 * ISO-639-1 code) collapses results to zero. Encode this per-endpoint;
 * never centralize it into a shared interceptor/default (that was the
 * original native `LanguageInterceptor.kt` footgun). This holds regardless of
 * the header's ES⇄EN toggle - `discover/movies|tv` stays language-free even
 * when `tmdbLanguageParam()` would resolve to `'en'`.
 */
export async function discoverMovies({ genre, page = 1 }: DiscoverByGenreParams = {}): Promise<JellyseerrSearchResponse> {
  const qs = new URLSearchParams({ page: String(page) });
  if (genre != null) qs.set('genre', String(genre));
  return apiFetch('jellyseerr', `/api/v1/discover/movies?${qs.toString()}`, {
    schema: JellyseerrSearchResponseSchema,
  });
}

/** TV counterpart of {@link discoverMovies} - same no-`language` rationale (ADR-4). */
export async function discoverTv({ genre, page = 1 }: DiscoverByGenreParams = {}): Promise<JellyseerrSearchResponse> {
  const qs = new URLSearchParams({ page: String(page) });
  if (genre != null) qs.set('genre', String(genre));
  return apiFetch('jellyseerr', `/api/v1/discover/tv?${qs.toString()}`, {
    schema: JellyseerrSearchResponseSchema,
  });
}

/**
 * Movie detail screen source (detail-request spec). `language` here mirrors
 * `search`/`discoverTrending` - this is a single-item locale lookup (like
 * TMDB's own `/movie/{id}?language=` param), not the `discover/*`
 * content-filter case ADR-4 documents, so it does NOT collapse results the
 * way `discover/movies|tv` does. Read dynamically via `tmdbLanguageParam()`
 * (the header's ES⇄EN toggle) on every call.
 */
export async function getMovieDetails(tmdbId: number): Promise<JellyseerrMovieDetails> {
  const qs = new URLSearchParams({ language: tmdbLanguageParam() });
  return apiFetch('jellyseerr', `/api/v1/movie/${tmdbId}?${qs.toString()}`, {
    schema: JellyseerrMovieDetailsSchema,
  });
}

/**
 * TV detail screen source, ported from {@link getMovieDetails}. Same
 * single-item locale lookup rationale (ADR-4 does NOT apply — this is not a
 * `discover/*` content filter). `useTitleDetail` normalizes the TMDB TV field
 * names onto the shared detail shape. `language` is read dynamically via
 * `tmdbLanguageParam()` (the header's ES⇄EN toggle) on every call.
 */
export async function getTvDetails(tmdbId: number): Promise<JellyseerrTvDetails> {
  const qs = new URLSearchParams({ language: tmdbLanguageParam() });
  return apiFetch('jellyseerr', `/api/v1/tv/${tmdbId}?${qs.toString()}`, {
    schema: JellyseerrTvDetailsSchema,
  });
}

export interface RequestMediaParams {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  /**
   * TV only: which seasons to request. Jellyseerr requires a `seasons` value
   * for a `tv` request; `'all'` asks for the whole series (the sensible default
   * until a per-season TV detail lands). Omitted entirely for movies so the
   * movie request body stays exactly `{ mediaType, mediaId }`.
   */
  seasons?: 'all' | number[];
}

export async function requestMedia({ mediaType, mediaId, seasons }: RequestMediaParams): Promise<JellyseerrRequestDto> {
  const body: Record<string, unknown> = { mediaType, mediaId };
  if (mediaType === 'tv') {
    body.seasons = seasons ?? 'all';
  }
  return apiFetch('jellyseerr', '/api/v1/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    schema: JellyseerrRequestDtoSchema,
  });
}

/**
 * Active Jellyseerr requests - Downloads screen source (projector-feature-map.md §9).
 */
export async function getRequests(
  filter = 'all',
  take = 20,
  skip = 0,
): Promise<JellyseerrRequestListResponse> {
  const qs = new URLSearchParams({ filter, take: String(take), skip: String(skip) });
  return apiFetch('jellyseerr', `/api/v1/request?${qs.toString()}`, {
    schema: JellyseerrRequestListResponseSchema,
  });
}

/**
 * Cancels a Jellyseerr request (Downloads screen's cancel flow, last step of
 * `useCancelDownload`'s best-effort chain) so the title leaves the requests
 * list. 204 No Content - no schema to validate.
 */
export async function deleteRequest(requestId: number): Promise<void> {
  await apiFetch('jellyseerr', `/api/v1/request/${requestId}`, { method: 'DELETE' });
}
