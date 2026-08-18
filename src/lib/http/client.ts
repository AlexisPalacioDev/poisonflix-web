import type { ZodType } from 'zod';
import { clearSession, getSession } from '../session/store';
import { ApiError, NetworkError } from './errors';

// Single fetch wrapper replacing the Kotlin reference's two OkHttp
// interceptors (`JellyfinAuthInterceptor` + `JellyseerrAuthInterceptor`,
// design.md §3.1). All requests are relative to the app origin under the
// env-driven `/jellyfin` and `/jellyseerr` prefixes - no hostnames in the
// client (ADR-1).

export type Backend = 'jellyfin' | 'jellyseerr' | 'prowlarr' | 'radarr' | 'sonarr' | 'bff';

const BASE_URLS: Record<Backend, string> = {
  jellyfin: import.meta.env.VITE_JELLYFIN_BASE ?? '/jellyfin',
  jellyseerr: import.meta.env.VITE_JELLYSEERR_BASE ?? '/jellyseerr',
  // The same-origin proxy routes these through the BFF, which authenticates
  // every call against the caller's Jellyseerr `connect.sid` session (see
  // credentials:'include' below) and enforces its own authorization rules
  // server-side (reads for any logged-in user, writes admin-only) - so no
  // API key or elevated credential ever reaches the browser bundle.
  prowlarr: import.meta.env.VITE_PROWLARR_BASE ?? '/prowlarr',
  radarr: import.meta.env.VITE_RADARR_BASE ?? '/radarr',
  sonarr: import.meta.env.VITE_SONARR_BASE ?? '/sonarr',
  // The BFF's own orchestration endpoints (e.g. /bff/cancel) - same
  // same-origin cookie auth as the rest of the BFF-fronted backends above.
  bff: import.meta.env.VITE_BFF_BASE ?? '/bff',
};

/**
 * The same-origin URL a backend call resolves to, without making it.
 *
 * For the rare consumer that has to hand a URL to something that fetches on
 * its own — an `<img>`, an `<audio>`, or the emulator streaming a ROM. Those
 * callers must not hardcode `/bff/...`: the prefixes are env-overridable
 * (`VITE_BFF_BASE` and friends), and a literal silently ignores the override.
 */
export function apiUrl(backend: Backend, path: string): string {
  return `${BASE_URLS[backend]}${path.startsWith('/') ? path : `/${path}`}`;
}

export interface ApiFetchOptions<T> extends Omit<RequestInit, 'body'> {
  body?: BodyInit | null;
  /** When provided, the parsed JSON body is validated against this schema;
   * a parse failure becomes a typed ApiError instead of silently returning
   * malformed data. */
  schema?: ZodType<T>;
  /**
   * Jellyfin token for THIS call only, instead of the one in the session store.
   *
   * The public cast route (`/cast/:id`) runs on a television that has no
   * session at all: its token arrives in the URL. Without this seam the only
   * way to make those calls authenticate would be to write the URL's token
   * into the session store — which would hand a one-video link the run of the
   * whole app.
   *
   * It also changes the 401 policy on purpose (see below): a token that came
   * from a URL is not the user's session, so its rejection must never clear
   * the session of whoever happens to be logged in on this browser.
   */
  authToken?: string;
}

export async function apiFetch<T = void>(
  backend: Backend,
  path: string,
  options: ApiFetchOptions<T> = {},
): Promise<T> {
  const { schema, headers, authToken, ...init } = options;
  const url = apiUrl(backend, path);

  const finalHeaders = new Headers(headers);
  const requestInit: RequestInit = { ...init, headers: finalHeaders };

  // SUPPLIED, not "non-empty". A caller that meant to pass a token and passed
  // `''` (a missing query-string param, say) must NOT silently fall through to
  // the session store: the cast route would then work only on the one machine
  // that is already logged in, which is precisely the bug this seam exists to
  // fix, wearing a disguise. Omitting the option entirely is the session path.
  const suppliedToken = typeof authToken === 'string';

  if (backend === 'jellyfin') {
    // Jellyfin auth: inject X-Emby-Token from the session store on every
    // call (mirrors JellyfinAuthInterceptor.kt). authenticateByName itself
    // carries its own X-Emby-Authorization header via `init.headers` before
    // any session exists, so this is a no-op for that call.
    const session = getSession();
    const token = suppliedToken ? authToken.trim() : session?.jellyfinToken;
    if (token) {
      finalHeaders.set('X-Emby-Token', token);
    }
  } else if (backend === 'jellyseerr' || backend === 'prowlarr' || backend === 'radarr' || backend === 'sonarr' || backend === 'bff') {
    // Jellyseerr auth: same-origin `connect.sid` cookie replays
    // automatically - no manual Cookie header needed (design.md §3.1, the
    // simplification the reverse proxy buys over AuthInterceptor.kt L45-59).
    // Radarr/Sonarr/Prowlarr/bff all sit behind the BFF now (security
    // hardening): the BFF authenticates every call against this same cookie
    // instead of the browser holding an *arr API key, so they need the exact
    // same credentials:'include' treatment as Jellyseerr itself.
    requestInit.credentials = 'include';
  }

  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (cause) {
    throw new NetworkError(undefined, { cause });
  }

  if (response.status === 401) {
    // Mirror AuthInterceptor.kt: clear the session, no retry. The route
    // guard reacts to the cleared session and bounces to onboarding.
    //
    // BUT only for the session-bearing backends (jellyfin/jellyseerr). A 401
    // from radarr/sonarr/prowlarr (and now bff) means the BFF rejected the
    // `connect.sid` cookie on THIS particular call - it's not authenticated
    // to the BFF - which in this dev environment happens routinely on a
    // background download-% poll that races the cookie. Clearing the session
    // here would log the user out app-wide every time that happens, so those
    // 401s surface as a plain ApiError the caller can swallow instead (e.g.
    // useDownloadProgress degrades to an empty map).
    if (backend === 'jellyfin' && suppliedToken) {
      // A token handed in per call (the public cast route's URL token) is NOT
      // this browser's session. Clearing on its behalf would log the real user
      // out because a link they were sent had gone stale.
      throw new ApiError(401, 'Unauthorized - the token supplied for this call was rejected');
    }
    if (backend === 'jellyfin' || backend === 'jellyseerr') {
      clearSession();
      throw new ApiError(401, 'Unauthorized - session cleared');
    }
    throw new ApiError(401, `Unauthorized - ${backend} is not authenticated to the BFF`);
  }

  // A stale/expired Jellyseerr session is rejected with 403 (NOT 401) by its
  // auth middleware ("You do not have permission to access this endpoint").
  // Every Jellyseerr GET the SPA makes is a read any authenticated user may
  // perform (search / discover / media detail) - admin-only actions go through
  // the BFF, never here - so a 403 on a GET can only mean the session died.
  // Treat it like the 401 above (clear + bounce to onboarding) instead of
  // surfacing a dead-end "couldn't load" the user can't recover from without
  // manually clearing the cookie. Writes keep the plain error: a 403 on POST
  // /request (user lacks the REQUEST permission) is a legitimate authz result.
  if (response.status === 403 && backend === 'jellyseerr' && (init.method ?? 'GET').toUpperCase() === 'GET') {
    clearSession();
    throw new ApiError(403, 'Forbidden - stale Jellyseerr session cleared');
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // No body, or not JSON - leave body undefined.
    }
    throw new ApiError(response.status, `Request failed: ${response.status} ${response.statusText}`, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const data = await response.json().catch(() => undefined);

  if (!schema) {
    return data as T;
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(response.status, `Response failed schema validation: ${parsed.error.message}`, data);
  }
  return parsed.data;
}
