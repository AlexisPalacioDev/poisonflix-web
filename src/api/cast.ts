import { apiFetch } from '../lib/http/client';
import { isApiError } from '../lib/http/errors';
import {
  CastDevicesResponseSchema,
  CastErrorBodySchema,
  CastPlayResponseSchema,
  CastStopResponseSchema,
  type CastDevice,
  type CastPlayResponse,
  type CastStopResponse,
} from './schemas/cast';

// Cast client. Same shape as the Juegos and Música clients: every call goes
// through `apiFetch('bff', '/cast/...')`, which replays the caller's
// `connect.sid` cookie. 'cast' is not a `Backend` of its own — it is a path
// under the BFF, which proxies to `cast-bridge` on the host network.

/** Everything the bridge can see on the LAN right now, usable or not. Devices
 *  with `capability: 'none'` are part of this list by design — the UI shows
 *  them with their reason instead of hiding a television the user can see. */
export async function fetchCastDevices(): Promise<CastDevice[]> {
  const { devices } = await apiFetch('bff', '/cast/devices', {
    schema: CastDevicesResponseSchema,
  });
  return devices;
}

export interface PlayOnDeviceParams {
  deviceId: string;
  /** Absolute URL of our own player page — used by `capability: 'app'` devices. */
  appUrl: string;
  /** Absolute URL of the Jellyfin stream — used by `capability: 'media'` devices. */
  mediaUrl: string;
  title: string;
}

/**
 * Both URLs go on every call, and the bridge's adapter picks the one its
 * protocol needs — the caller never has to know whether an LG TV wants a page
 * or a Chromecast wants a video. Building them is `features/cast/castUrls.ts`'s
 * job, because "absolute and reachable from the television" is a real
 * constraint the rest of the app never has to think about.
 */
export async function playOnDevice(params: PlayOnDeviceParams): Promise<CastPlayResponse> {
  return apiFetch('bff', '/cast/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    schema: CastPlayResponseSchema,
  });
}

export async function stopDevice(deviceId: string): Promise<CastStopResponse> {
  return apiFetch('bff', '/cast/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
    schema: CastStopResponseSchema,
  });
}

/**
 * The sentence a THROWN cast failure was carrying, or `null` when it was not
 * carrying one.
 *
 * A device that left the network comes back as HTTP 404 with
 * `reason: 'Ese dispositivo ya no aparece en la red. Volvé a escanear.'`, and
 * `apiFetch` raises that as an `ApiError` with the body attached. Without
 * reading it back the caller can only guess, and the guess it used to make
 * ("revisá que esté encendida y en la misma red") sends someone to inspect a
 * television that is working fine.
 *
 * `null` rather than a default string: the fallback belongs to the caller,
 * which is the only place that knows WHICH device the user tapped and whether
 * it was trying to start or to stop.
 */
export function castFailureReason(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const parsed = CastErrorBodySchema.safeParse(error.body);
  if (!parsed.success) return null;
  return parsed.data.reason ?? null;
}
