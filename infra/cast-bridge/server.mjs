// poisonflix-cast-bridge — the only component that can see the living room.
//
// It runs with `network_mode: host` because SSDP and mDNS are multicast and a
// bridge-network container gets ZERO answers to the exact same M-SEARCH (see
// README.md). Everything else about it is deliberately boring: no session, no
// keys, no state worth stealing, four routes.
//
// The bind address is the security boundary. On host networking `0.0.0.0` would
// publish "launch anything on the television" to every device on the LAN, past
// Caddy and past the Jellyseerr session the BFF checks. Binding the docker
// gateway means the containers on that bridge can reach it and nothing on the
// Wi-Fi can — so the only door in is the BFF's authenticated proxy.
//
// WHICH gateway is not a detail to guess: a host runs several docker bridges and
// binding the wrong one starts clean, logs nothing, and is unreachable from the
// BFF — a device list that is empty for a reason no log states. Measured on
// mendezserver: `media-automation` is 172.19.0.1 while `jellyfin-server_default`
// is 172.18.0.1, and on the development laptop the same network is 172.21.0.1.
// Compose therefore derives this AND the BFF's CAST_BRIDGE_URL from one
// CAST_GATEWAY_IP, so the two addresses cannot drift apart.
//
// Zero dependencies, like the BFF and for the same reason.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

import { scanDevices, toPublicDevice } from './discovery.mjs';
import { logError, logInfo } from './log.mjs';
import * as ssap from './adapters/ssap.mjs';
import * as dial from './adapters/dial.mjs';
import * as dlna from './adapters/dlna.mjs';
import * as cast from './adapters/cast.mjs';

const env = process.env;
// `||`, not a destructuring default: compose interpolates an unset variable as
// an EMPTY STRING, which is not `undefined` and would defeat a default — the
// same trap the BFF documents at the top of its own config block.
const BIND = env.CAST_BRIDGE_BIND || '172.19.0.1';
const PORT = Number(env.CAST_BRIDGE_PORT || 8791);

// A scan costs seconds of multicast waiting and the player screen asks every
// time it opens. Long enough that opening the sheet twice does not rescan,
// short enough that a TV someone just turned on shows up on the second look.
const CACHE_TTL_MS = Number(env.CAST_CACHE_TTL_MS || 8_000);
// Bodies here are four short strings.
const MAX_BODY_BYTES = 64 * 1024;
// Where the SSAP adapter persists the webOS client-key; checked at boot below.
const DATA_DIR = env.CAST_DATA_DIR || '/data';

/** Every non-loopback IPv4 this host owns, for the startup line. */
function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && (iface.family === 'IPv4' || iface.family === 4) && !iface.internal)
    .map((iface) => iface.address);
}

const ADAPTERS = { ssap, dial, dlna, cast };

// ---------------------------------------------------------------------------
// Device cache
// ---------------------------------------------------------------------------

/** @type {{ at: number, devices: any[] }} */
let cache = { at: 0, devices: [] };
/** @type {Promise<any[]> | null} */
let inFlight = null;
/** When an unknown device id last bought a forced rescan — see findDevice. */
let lastForcedScan = 0;

/**
 * The current device list, scanning if the cache is cold.
 *
 * Single-flight matters more than the TTL: the SPA opens the cast sheet and can
 * easily fire two /devices calls, and two concurrent scans mean two sets of
 * sockets on every interface racing for the same answers.
 */
async function currentDevices({ force = false } = {}) {
  // The TTL is honoured even when the last scan found NOTHING. Treating an
  // empty result as "cache miss, look again" sounds helpful and is not: a house
  // with no cast devices would then pay a full multicast scan on every single
  // poll of the player screen, forever. A TV someone just switched on shows up
  // one TTL later, which is what the TTL is for.
  const fresh = cache.at > 0 && Date.now() - cache.at < CACHE_TTL_MS;
  if (!force && fresh) return cache.devices;
  if (inFlight) return await inFlight;

  inFlight = scanDevices()
    .then((devices) => {
      cache = { at: Date.now(), devices };
      return devices;
    })
    .catch((err) => {
      // A failed scan must never take the player screen down with it — the
      // contract says /devices answers 200 with an empty list. What it must not
      // do is fail quietly, hence the line.
      logError('cast.scan', err, {});
      return cache.devices;
    })
    .finally(() => {
      inFlight = null;
    });

  return await inFlight;
}

/**
 * A device by id, rescanning once if it is not in the cache.
 *
 * The rescan is for the restart case: an id only ever comes from a previous
 * /devices call, so a miss means this process lost its cache (a redeploy, a
 * crash) while the browser kept the id. Failing there would make casting break
 * until the user thought to pull-to-refresh a list that looks correct.
 */
async function findDevice(deviceId) {
  const devices = await currentDevices();
  const hit = devices.find((device) => device.id === deviceId);
  if (hit) return hit;

  // Throttled, and that matters: without the guard EVERY unknown id bought a
  // full multicast scan, so a client retrying a stale id in a loop would keep
  // the LAN busy indefinitely. One forced scan per TTL window keeps the restart
  // case working (the first miss still looks again) and bounds the rest.
  if (Date.now() - lastForcedScan < CACHE_TTL_MS) return null;
  lastForcedScan = Date.now();
  const rescanned = await currentDevices({ force: true });
  return rescanned.find((device) => device.id === deviceId) || null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * `Connection: close` is what ends an oversized upload. Destroying the request
 * instead tears the socket down before the 413 can flush, so the caller sees a
 * transport error rather than the answer — the BFF documents that scar in
 * `sendTooLarge`.
 */
function sendTooLarge(res) {
  return send(res, 413, { ok: false, error: 'payload_too_large' }, { connection: 'close' });
}

/** @returns {Promise<object | 'too_large' | null>} null = unparseable. */
function readJson(req) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Pause rather than destroy, so the response can still be written — the
        // BFF learned this one the hard way (see `sendTooLarge` there).
        req.pause();
        done('too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        done(null);
      }
    });
    req.on('error', () => done(null));
  });
}

async function handleDevices(res) {
  const devices = await currentDevices();
  return send(res, 200, { devices: devices.map(toPublicDevice) });
}

/**
 * Run one adapter action for a device the caller named.
 *
 * `ok: false` travels with HTTP 200 on purpose: "the TV does not have the app"
 * and "accept the prompt on screen" are things the person holding the phone can
 * act on, and a 5xx would make the SPA show a generic failure instead of the
 * sentence that tells them what to do.
 */
async function runAction(res, body, action) {
  if (body === 'too_large') return sendTooLarge(res);
  if (!body || typeof body.deviceId !== 'string' || !body.deviceId) {
    return send(res, 400, { ok: false, error: 'bad_request', reason: 'Falta el dispositivo.' });
  }

  const device = await findDevice(body.deviceId);
  if (!device) {
    return send(res, 404, {
      ok: false,
      error: 'unknown_device',
      reason: 'Ese dispositivo ya no aparece en la red. Volvé a escanear.',
    });
  }

  const adapter = ADAPTERS[device.protocol];
  if (!adapter) {
    // Unreachable unless discovery grows a protocol the adapters do not have —
    // which is exactly the kind of thing that otherwise fails in silence.
    logError('cast.adapter', `no adapter for ${device.protocol}`, { id: device.id });
    return send(res, 500, { ok: false, error: 'no_adapter', reason: 'Ese dispositivo no se puede manejar desde acá.' });
  }

  if (device.capability === 'none') {
    // The device was listed WITH its reason; repeating it here means the answer
    // to "why did nothing happen" is the same sentence in both places.
    return send(res, 200, {
      ok: false,
      reason: device.reason || 'Ese dispositivo no se puede usar para reproducir.',
    });
  }

  let result;
  try {
    result = await action(adapter, device);
  } catch (err) {
    logError(`cast.${device.protocol}`, err, { id: device.id });
    return send(res, 200, {
      ok: false,
      reason: 'Algo falló al hablar con el dispositivo. Probá de nuevo.',
    });
  }

  return send(res, 200, {
    ok: Boolean(result?.ok),
    ...(result?.needsPairing ? { needsPairing: true } : {}),
    ...(result?.reason ? { reason: result.reason } : {}),
  });
}

/**
 * The whole API. Exported so `node --test` can drive it over a real socket
 * without this module binding the LAN port at import time — the same reason
 * `handleGames` lives outside the BFF's server.mjs.
 */
export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://cast-bridge');
    const path = url.pathname;

    if (path === '/healthz') return send(res, 200, { ok: true });

    if (path === '/devices') {
      if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
      return await handleDevices(res);
    }

    if (path === '/play') {
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const body = await readJson(req);
      return await runAction(res, body, (adapter, device) =>
        adapter.play(device, {
          // Both URLs arrive on every call and the ADAPTER picks: the caller
          // knows what it wants to show, not which of the four protocols the
          // living room happens to speak today.
          appUrl: typeof body.appUrl === 'string' ? body.appUrl : null,
          mediaUrl: typeof body.mediaUrl === 'string' ? body.mediaUrl : null,
          title: typeof body.title === 'string' ? body.title : null,
        }),
      );
    }

    if (path === '/stop') {
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const body = await readJson(req);
      return await runAction(res, body, (adapter, device) => adapter.stop(device));
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    logError('cast.router', err, { method: req.method, url: req.url });
    if (!res.headersSent) return send(res, 500, { error: 'internal' });
    return res.destroy();
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

/**
 * Prove at boot that the webOS `client-key` will be storable.
 *
 * This failure is invisible where it happens: a pairing succeeds, the TV plays,
 * and only the NEXT cast shows the prompt again — so the owner experiences "the
 * television keeps asking" with nothing anywhere pointing at a directory owned
 * by root. Docker creates a missing bind-mount source as root:root and this
 * container runs as `node`, which is exactly how that happens on a first
 * deploy. One line at startup turns a recurring mystery into a fixable fact.
 */
async function checkDataDir() {
  const probe = join(DATA_DIR, '.write-probe');
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(probe, '', 'utf8');
    await rm(probe, { force: true });
  } catch (err) {
    logError('cast.data', err, {
      dataDir: DATA_DIR,
      hint: 'pairing keys cannot be stored; the LG will ask for permission on every cast',
    });
  }
}

function start() {
  // Same backstop as the BFF, and installed HERE rather than at import: an
  // unguarded process exits on any stray async error and takes every in-flight
  // request with it, but a test that imports this module has no business
  // inheriting a handler that calls `process.exit`. Rejections are logged and
  // survived; an uncaughtException leaves the process in an unknown state, so
  // it is logged and then allowed to exit for Docker to restart.
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason, {}));
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err, {});
    process.exit(1);
  });

  server.on('error', (err) => {
    // The realistic failure is EADDRNOTAVAIL: CAST_GATEWAY_IP names a bridge
    // this host does not have. Falling back to 0.0.0.0 would "fix" it by
    // publishing the launch API to the whole LAN, so it fails loudly instead —
    // a restart loop with this line in it is a bug report, a silent bind to
    // 0.0.0.0 is a hole nobody would ever notice.
    logError('cast.listen', err, { bind: BIND, port: PORT });
    process.exit(1);
  });
  void checkDataDir();
  server.listen(PORT, BIND, () => {
    // The local addresses are logged with the bind because the dangerous
    // failure is not "the address does not exist" (that exits above) but
    // "it exists and belongs to a DIFFERENT docker bridge than the one the BFF
    // talks to" — a process that looks perfectly healthy and is unreachable.
    logInfo('cast.listen', 'poisonflix-cast-bridge listening', {
      bind: BIND,
      port: PORT,
      localAddresses: localAddresses(),
    });
  });
}

// Only when run as the entrypoint. Importing this module from a test must not
// open a socket on the LAN.
const entrypoint = process.argv[1] ? resolvePath(process.argv[1]) : null;
if (entrypoint && entrypoint === fileURLToPath(import.meta.url)) start();
