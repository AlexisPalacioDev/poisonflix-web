import { z } from 'zod';

// Cast feature schemas, mirroring the shared cast contract one-for-one.
//
// The devices themselves are discovered by `cast-bridge`, a service on the
// host network (a bridged container sees zero devices over SSDP — measured),
// and reach the browser through the BFF, which only proxies. So nothing here
// is stored anywhere: a device list is a snapshot of the LAN at the moment it
// was scanned.

/** How the bridge talks to the device. The browser never acts on this beyond
 *  showing it — `capability` is what decides whether a device is usable. */
export const CastProtocolSchema = z.enum(['ssap', 'dial', 'dlna', 'cast']);
export type CastProtocol = z.infer<typeof CastProtocolSchema>;

/**
 * What the device can be asked to do:
 * - `app`   — it runs OUR app, and gets handed a page URL (`appUrl`).
 * - `media` — it plays a video URL directly (`mediaUrl`).
 * - `none`  — discovered, but unusable; `reason` says why, in Spanish.
 */
export const CastCapabilitySchema = z.enum(['app', 'media', 'none']);
export type CastCapability = z.infer<typeof CastCapabilitySchema>;

// Both enums are validated STRICTLY, which is deliberate. A value outside
// these sets means the bridge and this bundle disagree about the contract —
// a deploy skew — and the whole response failing loudly is the honest
// outcome. The quiet alternative (drop the unknown device, render the rest)
// would hide exactly the mismatch someone needs to see.
export const CastDeviceSchema = z.object({
  /** Stable across scans: `${protocol}:${address}`. Opaque to the client — the
   *  only thing done with it is handing it back on `/play` and `/stop`. */
  id: z.string(),
  name: z.string(),
  address: z.string(),
  protocol: CastProtocolSchema,
  capability: CastCapabilitySchema,
  /** The contract requires this whenever `capability === 'none'`, but it stays
   *  optional here on purpose: a bridge that forgot one on a single device
   *  must not blank out the entire list. The UI carries a fallback sentence
   *  instead, so a device is never shown as unusable with no explanation. */
  reason: z.string().optional(),
  model: z.string().optional(),
});
export type CastDevice = z.infer<typeof CastDeviceSchema>;

// `.default([])` so a bridge-less deployment (the BFF answers `{}` or
// `{ devices: [] }` with HTTP 200 rather than a 5xx — cast being absent must
// never break the player) lands on the empty-state, not on a parse error.
export const CastDevicesResponseSchema = z.object({
  devices: z.array(CastDeviceSchema).default([]),
});
export type CastDevicesResponse = z.infer<typeof CastDevicesResponseSchema>;

/**
 * `needsPairing` is NOT an error: the TV is showing a confirmation prompt and
 * the user has to accept it on the television. Retrying afterwards works,
 * which is why it travels alongside `ok` instead of as a failed request.
 *
 * `reason` is the whole point of `ok: false` riding an HTTP 200. The adapters
 * spend real effort turning a protocol failure into a sentence the person
 * holding the remote can act on — "La TV ya no tiene la app PoisonFlix
 * instalada. Instalala desde su tienda y volvé a escanear." — and zod STRIPS
 * every key a schema does not declare. Leaving it out did not leave the UI
 * slightly poorer: it deleted the answer at the parse and left one generic
 * "probá de nuevo" standing in for a dozen different diagnoses.
 */
export const CastPlayResponseSchema = z.object({
  ok: z.boolean(),
  needsPairing: z.boolean().optional(),
  reason: z.string().optional(),
});
export type CastPlayResponse = z.infer<typeof CastPlayResponseSchema>;

/** Same envelope as `/play`, and for the same reason: stopping fails in as many
 *  ways as starting does ("El Chromecast no está reproduciendo nada de
 *  PoisonFlix."), and the LG adapter can even answer `needsPairing` here — the
 *  TV has to accept the connection before it will close anything. */
export const CastStopResponseSchema = z.object({
  ok: z.boolean(),
  needsPairing: z.boolean().optional(),
  reason: z.string().optional(),
});
export type CastStopResponse = z.infer<typeof CastStopResponseSchema>;

/**
 * The body a NON-2xx cast response carries.
 *
 * The bridge answers `ok: false` with HTTP 200 for anything the television
 * decided, and reserves real status codes for the request itself: 400 for a
 * missing device, 404 for one that left the network
 * ("Ese dispositivo ya no aparece en la red. Volvé a escanear."), 500 for a
 * protocol it cannot drive. Those bodies carry the SAME actionable `reason`,
 * but `apiFetch` turns them into a thrown `ApiError` — so without reading it
 * back out of `error.body`, a 404 surfaced as "revisá que esté encendida y en
 * la misma red", advice for a problem the user does not have.
 *
 * Every field is optional on purpose: the BFF's own failures
 * (`{ error: 'cast_bridge_unreachable' }`) and the bridge's router catch-all
 * (`{ error: 'internal' }`) carry no `reason` and not even an `ok`. Those must
 * parse cleanly and simply yield nothing to say, so the caller falls back to
 * its own copy instead of the whole extraction throwing.
 */
export const CastErrorBodySchema = z.object({
  error: z.string().optional(),
  reason: z.string().optional(),
});
export type CastErrorBody = z.infer<typeof CastErrorBodySchema>;
