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

export interface ApiFetchOptions<T> extends Omit<RequestInit, 'body'> {
  body?: BodyInit | null;
  /** When provided, the parsed JSON body is validated against this schema;
   * a parse failure becomes a typed ApiError instead of silently returning
   * malformed data. */
  schema?: ZodType<T>;
}

export async function apiFetch<T = void>(
  backend: Backend,
  path: string,
  options: ApiFetchOptions<T> = {},
): Promise<T> {
  const { schema, headers, ...init } = options;
  const base = BASE_URLS[backend];
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const finalHeaders = new Headers(headers);
  const requestInit: RequestInit = { ...init, headers: finalHeaders };

  if (backend === 'jellyfin') {
    // Jellyfin auth: inject X-Emby-Token from the session store on every
    // call (mirrors JellyfinAuthInterceptor.kt). authenticateByName itself
    // carries its own X-Emby-Authorization header via `init.headers` before
    // any session exists, so this is a no-op for that call.
    const session = getSession();
    if (session?.jellyfinToken) {
      finalHeaders.set('X-Emby-Token', session.jellyfinToken);
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
    if (backend === 'jellyfin' || backend === 'jellyseerr') {
      clearSession();
      throw new ApiError(401, 'Unauthorized - session cleared');
    }
    throw new ApiError(401, `Unauthorized - ${backend} is not authenticated to the BFF`);
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
