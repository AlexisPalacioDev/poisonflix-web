import { apiFetch } from '../lib/http/client';

// BFF orchestration client (security hardening: the browser no longer drives
// the multi-step cancel flow itself). Every call here goes through
// `apiFetch('bff', ...)`, which sends the same `connect.sid` cookie as
// Jellyseerr - the BFF authenticates against that session and authorizes the
// action server-side (owner-or-admin for cancel), the same way it already
// gates radarr/sonarr reads/writes.

/**
 * Cancels an in-flight download: the BFF performs the entire orchestration
 * server-side (radarr/sonarr queue delete + unmonitor + Jellyseerr request
 * delete) and returns 204. Replaces the client-side best-effort chain that
 * used to live in `useCancelDownload` (arr resolution, queue cancel,
 * unmonitor, then `deleteRequest` - see git history for the old shape).
 */
export async function cancelDownload(requestId: number, tmdbId: number | null): Promise<void> {
  await apiFetch('bff', '/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, tmdbId }),
  });
}
