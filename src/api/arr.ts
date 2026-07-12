import { buildArrBaseUrl, type ArrConfig } from '../lib/domain/config';

// *arr (Radarr/Sonarr/Prowlarr) client shape, ported from `ArrApi.kt`.
// Deferred surface (design.md §3.2, tasks.md Slice 1 note "deferred") - not
// wired into any UI in the MVP. Exists so the cancel/unmonitor pattern isn't
// precluded later: GET-raw -> flip `monitored:false` -> PUT-back-unmodified,
// so a future typed round-trip can't silently drop fields.

export interface ArrMovie {
  id: number;
  monitored: boolean;
  [key: string]: unknown;
}

function authHeaders(config: ArrConfig): HeadersInit {
  return { 'X-Api-Key': config.apiKey };
}

export async function getMovie(config: ArrConfig, id: number): Promise<ArrMovie> {
  const res = await fetch(`${buildArrBaseUrl(config)}/api/v3/movie/${id}`, {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    throw new Error(`Arr getMovie failed: ${res.status}`);
  }
  return res.json();
}

/**
 * GET-raw -> flip `monitored` -> PUT-back-unmodified: never re-derive a typed
 * request body from scratch, so unrelated fields Radarr returns are never
 * silently dropped by a round-trip through a narrower type.
 */
export async function setMonitored(config: ArrConfig, id: number, monitored: boolean): Promise<ArrMovie> {
  const current = await getMovie(config, id);
  const updated: ArrMovie = { ...current, monitored };
  const res = await fetch(`${buildArrBaseUrl(config)}/api/v3/movie/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  if (!res.ok) {
    throw new Error(`Arr setMonitored failed: ${res.status}`);
  }
  return res.json();
}
