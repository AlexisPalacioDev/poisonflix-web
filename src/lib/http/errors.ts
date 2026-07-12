// Error typing required by the onboarding spec's proxy-vs-auth distinction:
// a proxy/CORS misconfiguration MUST read differently from a wrong password.
// Ported from `AuthInterceptor.kt`'s error-surfacing behavior (design.md §3.1).

/** A non-2xx HTTP response, or a response that failed schema validation. */
export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A `fetch` call that never reached the server: connectivity down, DNS
 * failure, or the reverse proxy unreachable. The Fetch spec deliberately
 * hides the CORS-vs-plain-network distinction from script (both throw an
 * opaque `TypeError: Failed to fetch`), so this is the base class for both.
 */
export class NetworkError extends Error {
  constructor(
    message = 'Network request failed - check connectivity or the reverse-proxy configuration',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/**
 * Same-origin proxy/CORS misconfiguration. Kept as a distinguishable subtype
 * of NetworkError so call sites can be explicit about intent (e.g. onboarding
 * surfacing "check the reverse proxy" copy) even though the browser cannot
 * reliably tell this apart from a generic connectivity failure at throw time.
 */
export class CorsError extends NetworkError {
  constructor(
    message = 'Request blocked - check the reverse-proxy /jellyfin or /jellyseerr path prefix',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CorsError';
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}
