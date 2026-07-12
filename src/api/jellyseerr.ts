import { apiFetch } from '../lib/http/client';
import {
  JellyseerrMovieDetailsSchema,
  JellyseerrRequestDtoSchema,
  JellyseerrRequestListResponseSchema,
  JellyseerrSearchResponseSchema,
  JellyseerrUserSchema,
  type JellyseerrMovieDetails,
  type JellyseerrRequestDto,
  type JellyseerrRequestListResponse,
  type JellyseerrSearchResponse,
  type JellyseerrUser,
} from './schemas/jellyseerr';

// Jellyseerr REST client, ported from `JellyseerrApi.kt` (design.md §3.2).

const SPANISH_LATINO = 'es-MX';

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
 * TMDB-backed multi-search; movie/tv results carry an embedded `mediaInfo`
 * once tracked.
 *
 * `query` is percent-encoded via `encodeURIComponent` rather than folded into
 * `URLSearchParams` - confirmed live that Jellyseerr's search endpoint
 * rejects `URLSearchParams`'s `+`-for-space encoding with 400 ("Parameter
 * 'query' must be url encoded"), even though `discover/trending`'s
 * space-free params never exposed this. Multi-word queries (e.g. "Breaking
 * Bad") would otherwise 400 on every keystroke that settles.
 */
export async function search(query: string, page = 1): Promise<JellyseerrSearchResponse> {
  const qs = new URLSearchParams({ page: String(page), language: SPANISH_LATINO });
  return apiFetch('jellyseerr', `/api/v1/search?query=${encodeURIComponent(query)}&${qs.toString()}`, {
    schema: JellyseerrSearchResponseSchema,
  });
}

/** Home's Trending row source - mixed movie/tv trending list. */
export async function discoverTrending(page = 1): Promise<JellyseerrSearchResponse> {
  const qs = new URLSearchParams({ page: String(page), language: SPANISH_LATINO });
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
 * original native `LanguageInterceptor.kt` footgun).
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
 * Movie detail screen source (detail-request spec). `language=es-MX` here
 * mirrors `search`/`discoverTrending` - this is a single-item locale lookup
 * (like TMDB's own `/movie/{id}?language=` param), not the `discover/*`
 * content-filter case ADR-4 documents, so it does NOT collapse results the
 * way `discover/movies|tv` does.
 */
export async function getMovieDetails(tmdbId: number): Promise<JellyseerrMovieDetails> {
  const qs = new URLSearchParams({ language: SPANISH_LATINO });
  return apiFetch('jellyseerr', `/api/v1/movie/${tmdbId}?${qs.toString()}`, {
    schema: JellyseerrMovieDetailsSchema,
  });
}

export interface RequestMediaParams {
  mediaType: 'movie' | 'tv';
  mediaId: number;
}

export async function requestMedia({ mediaType, mediaId }: RequestMediaParams): Promise<JellyseerrRequestDto> {
  return apiFetch('jellyseerr', '/api/v1/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaType, mediaId }),
    schema: JellyseerrRequestDtoSchema,
  });
}

/**
 * Active Jellyseerr requests - reserved for the deferred Downloads screen
 * (tasks.md Slice 1, note "deferred"). Not called from any UI yet.
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
