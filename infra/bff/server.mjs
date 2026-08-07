// poisonflix-bff — the ONLY component that holds the *arr admin API keys and the
// only thing Caddy routes /prowlarr /radarr /sonarr /bff to. Every request is
// authenticated against the caller's Jellyseerr session (the same-origin
// `connect.sid` cookie) before any backend is touched. Authorization lives here,
// on the server — the SPA is never trusted (see design.md "Threat model").
//
// Zero runtime dependencies: Node's built-in http + global fetch (Node >= 18).

import { createServer } from 'node:http';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  createInvite,
  listInvites,
  revokeInvite,
  consumeInvite,
  checkInvite,
} from './invites.mjs';
import {
  validateUsername,
  validatePassword,
  userExists,
  listUsers,
  createUser,
  setPassword,
  deleteUser,
  importToJellyseerr,
} from './identity.mjs';
import {
  attach as jamAttach,
  currentSnapshot as jamSnapshot,
  createJam,
  listJamsForUser,
  inviteMembers,
  respondToInvite,
  leaveJam,
  removeMember,
  setRole,
  transferOwnership,
  setMode,
  addTracks,
  removeTrack,
  transport,
} from './jam.mjs';

// `||`, not destructuring defaults. A default only applies to `undefined`, and
// docker-compose.override.yml interpolates `${JELLYSEERR_URL}` with no `:-`
// fallback — so a missing .env substitutes an EMPTY STRING, the default never
// engages, and `fetch('/api/v1/auth/me')` throws a URL-parse error that
// resolveUser swallows into `user = null`. Every user would get 401 forever,
// with no log line and a container that looks perfectly healthy.
const env = process.env;
const PORT = env.PORT || '8787';
const JELLYSEERR_URL = env.JELLYSEERR_URL || 'http://jellyseerr:5055';
const RADARR_URL = env.RADARR_URL || 'http://radarr:7878';
const SONARR_URL = env.SONARR_URL || 'http://sonarr:8989';
const PROWLARR_URL = env.PROWLARR_URL || 'http://prowlarr:9696';
const RADARR_API_KEY = env.RADARR_API_KEY || '';
const SONARR_API_KEY = env.SONARR_API_KEY || '';
const PROWLARR_API_KEY = env.PROWLARR_API_KEY || '';
// Internal audio downloader for the "Música" feature (poisonflix-music-worker).
// Reachable only from the BFF; every call below is gated on an authenticated
// Jellyseerr session, same as the rest of the BFF-fronted backends.
const MUSIC_WORKER_URL = env.MUSIC_WORKER_URL || 'http://music-worker:8790';
// Where /bff/client-log's reports are durably mirrored — see `persistClientLog`
// below. Same env-override convention as invites.mjs's `INVITES_FILE`.
const CLIENT_LOG_FILE = env.CLIENT_LOG_FILE || '/data/client-log.ndjson';
// This is a debugging aid, not an audit trail — keep it small. One rotated
// backup is kept (`${CLIENT_LOG_FILE}.1`), so worst case on disk is ~2x this.
const CLIENT_LOG_MAX_BYTES = 1_000_000;
// Per-entry ceiling, deliberately far below the rotation cap above. A report is
// a scope, a message and a small detail object; anything larger is a bug or an
// abuse of a route that takes no authentication.
const CLIENT_LOG_MAX_ENTRY_BYTES = 4_000;

// ---- Upstream timeouts ----
// Undici has NO total-request timeout by default, so a HUNG upstream (as opposed
// to a dead one, which is already handled) pinned the BFF until Node's 300s
// requestTimeout. The worst case is AUTH_TIMEOUT_MS: resolveUser sits on the
// critical path of every route, so one hung Jellyseerr hung the entire BFF —
// including routes that never touch Jellyseerr.
const AUTH_TIMEOUT_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 20_000;

// Jellyseerr permission bitfield: ADMIN grants everything and is bit 2.
const PERMISSION_ADMIN = 2;

// prefix -> upstream. The key is injected here so it never reaches the browser.
const BACKENDS = {
  radarr: { base: RADARR_URL, key: RADARR_API_KEY },
  sonarr: { base: SONARR_URL, key: SONARR_API_KEY },
  prowlarr: { base: PROWLARR_URL, key: PROWLARR_API_KEY },
};

// ---------------------------------------------------------------------------
// Auth: resolve the caller from the Jellyseerr session cookie, short-TTL cached
// so a burst of download-% polls doesn't hammer /auth/me.
// ---------------------------------------------------------------------------

const AUTH_TTL_MS = 30_000;
// Hard ceiling, not a sweep trigger. Far above any real household's concurrent
// sessions, so eviction only ever bites an abusive caller.
const AUTH_CACHE_MAX = 512;
/** @type {Map<string, { exp: number, user: { id: number, isAdmin: boolean } | null }>} */
const authCache = new Map();

/** @returns {Promise<{ id: number, isAdmin: boolean } | null>} null = not authenticated. */
async function resolveUser(cookie) {
  if (!cookie) return null;

  const cached = authCache.get(cookie);
  const now = Date.now();
  if (cached && cached.exp > now) return cached.user;

  let user = null;
  try {
    const res = await fetch(`${JELLYSEERR_URL}/api/v1/auth/me`, {
      headers: { cookie, accept: 'application/json' },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.json();
      user = {
        id: Number(body?.id),
        isAdmin: (Number(body?.permissions) & PERMISSION_ADMIN) === PERMISSION_ADMIN,
      };
    }
  } catch {
    user = null; // Jellyseerr unreachable -> treat as unauthenticated, fail closed.
  }

  authCache.set(cookie, { exp: now + AUTH_TTL_MS, user });
  if (authCache.size > AUTH_CACHE_MAX) pruneAuthCache(now);
  return user;
}

// The key is the whole raw Cookie header — fully attacker-controlled. Sweeping
// only EXPIRED entries meant an unauthenticated caller sending distinct Cookie
// headers faster than the 30s TTL grew the map without bound, while the sweep
// found nothing to delete and burned CPU walking it on every insert. So expire
// first, then enforce a hard ceiling by evicting oldest-first: Map preserves
// insertion order, which makes that a FIFO with no extra bookkeeping.
function pruneAuthCache(now) {
  for (const [k, v] of authCache) if (v.exp <= now) authCache.delete(k);
  while (authCache.size > AUTH_CACHE_MAX) {
    const oldest = authCache.keys().next();
    if (oldest.done) break;
    authCache.delete(oldest.value);
  }
}

// Structured error log. The BFF ran for days emitting exactly ONE line (its own
// startup banner) while users hit failures, because every failure path either
// swallowed the error or answered a status with no trace. One line per failure,
// to stdout, is what makes `docker compose logs bff` worth reading.
function logError(scope, err, detail) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ at: new Date().toISOString(), level: 'error', scope, message, ...detail }),
  );
}

// ---------------------------------------------------------------------------
// Client-side diagnostics persistence — bounded, rotated NDJSON file.
//
// `docker compose logs bff` is NOT durable: it rotates/truncates on its own
// schedule and a redeploy clears the buffer entirely. That is exactly why the
// duration-defect telemetry (`music.player.durationMismatch`) that was added
// for this bug never left a trace anyone could read — the report reached
// stdout, but nothing kept it. Client reports now also land in a small file
// under /data (same volume invites.mjs already persists to), one JSON object
// per line, so a report survives both container restarts and log rotation.
//
// Bounded and rotated so a client stuck logging in a loop cannot grow this
// file without limit or take the BFF down with it: once the current file
// reaches CLIENT_LOG_MAX_BYTES it is rotated to a single `.1` backup (the
// previous backup, if any, is overwritten) and a fresh file is started.
// ---------------------------------------------------------------------------

/** Serializes rotate+append so two concurrent client-log POSTs can't race. */
let clientLogQueue = Promise.resolve();
function withClientLogLock(fn) {
  const run = clientLogQueue.then(fn, fn);
  // Keep the chain alive but swallow errors so one failure doesn't poison it.
  clientLogQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Append one NDJSON line, rotating the file first if it has grown past the
 * cap. Never throws and never rejects — a diagnostic write must not fail (or
 * slow down) the request it is diagnosing, let alone crash the process.
 */
function persistClientLog(entry) {
  return withClientLogLock(async () => {
    // One entry must never be able to age out the file on its own. The route
    // shares the global MAX_BODY_BYTES (1 MB), which equals the rotation cap —
    // so without this a single POST rotates and a second one overwrites the
    // backup, erasing every report. That is the opposite of what this file is
    // for: it exists because a defect only reproduces on the owner's phone.
    // At this cap it takes thousands of entries to rotate, which is a real
    // history rather than a two-request wipe.
    let line = JSON.stringify(entry);
    if (line.length > CLIENT_LOG_MAX_ENTRY_BYTES) {
      line = JSON.stringify({
        at: entry.at,
        scope: entry.scope,
        message: String(entry.message ?? '').slice(0, 500),
        truncated: line.length,
      });
    }

    await mkdir(dirname(CLIENT_LOG_FILE), { recursive: true });
    try {
      const { size } = await stat(CLIENT_LOG_FILE);
      if (size >= CLIENT_LOG_MAX_BYTES) {
        await rename(CLIENT_LOG_FILE, `${CLIENT_LOG_FILE}.1`); // overwrites prior backup
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await appendFile(CLIENT_LOG_FILE, `${line}\n`, 'utf8');
  }).catch((err) => {
    logError('client.persist', err, {});
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

// Every body this service handles is small: a register payload, a cancel, a music
// request, or a full *arr movie object on the unmonitor PUT. Uncapped, an attacker
// could stream unbounded data into memory, and the public /bff/register reaches
// this after only the rate-limit check.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Answer an over-sized upload.
 *
 * Deliberately does NOT touch the request. Calling `req.destroy()` here tore the
 * socket down before the response could flush, so the client never saw the 413 —
 * curl reported a bare `100` and Caddy turned it into a 502. `Connection: close`
 * is what ends the upload: Node writes the response, then closes, and the sender
 * stops. readBody has already paused and stopped buffering, so nothing is
 * accumulating in the meantime.
 */
function sendTooLarge(res) {
  return send(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
}

class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Pause, do NOT destroy. Destroying here killed the socket before a
        // response could be written, so the caller's 413 never left the process
        // and Caddy reported a bare 502 instead. Pausing stops the flow and stops
        // buffering — which is what bounds the memory — while leaving the socket
        // alive long enough to answer properly. The caller destroys it after.
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A *arr call the BFF makes itself, with the admin key. Returns parsed JSON or null. */
async function arrFetch(backendKey, path, init = {}) {
  const backend = BACKENDS[backendKey];
  const res = await fetch(`${backend.base}${path}`, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ...init,
    headers: { 'X-Api-Key': backend.key, accept: 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${backendKey} ${path} -> ${res.status}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Passthrough: /{prowlarr|radarr|sonarr}/<rest> — reads for any user, Prowlarr
// grab for any user, destructive writes for admins only.
// ---------------------------------------------------------------------------

// Allowlisted GET pathnames per backend — the exact reads the SPA needs. A blanket
// "GET is fine" would leak secrets: *arr config endpoints (config/host,
// downloadclient, indexer, notification, ...) return the API key and the
// download-client / indexer credentials in their response body. Deny by default.
const GET_ALLOW = {
  radarr: [/^\/api\/v3\/queue$/, /^\/api\/v3\/movie$/, /^\/api\/v3\/movie\/\d+$/],
  sonarr: [
    /^\/api\/v3\/queue$/,
    /^\/api\/v3\/series$/,
    /^\/api\/v3\/series\/\d+$/,
    /^\/api\/v3\/episode$/,
  ],
  prowlarr: [/^\/api\/v1\/search$/],
};

// The exact mutating paths the SPA needs — nothing else. Derived from src/api/arr.ts:
// delete movie/series, cancel a queue item, unmonitor a movie (full-object PUT) and
// batch-unmonitor episodes.
const MUTATE_ALLOW = {
  radarr: [/^\/api\/v3\/movie\/\d+$/, /^\/api\/v3\/queue\/\d+$/],
  sonarr: [
    /^\/api\/v3\/series\/\d+$/,
    /^\/api\/v3\/queue\/\d+$/,
    /^\/api\/v3\/episode\/monitor$/,
  ],
  prowlarr: [],
};

function isAllowedPassthrough(method, prefix, restPath, user) {
  const pathname = restPath.split('?')[0];
  if (method === 'GET') {
    return (GET_ALLOW[prefix] || []).some((re) => re.test(pathname));
  }
  if (method === 'POST' && prefix === 'prowlarr' && pathname === '/api/v1/search') {
    return true; // grab / "Pedir"
  }
  if (method === 'DELETE' || method === 'PUT') {
    // Admin was necessary but NOT sufficient. This used to allow admins ANY path
    // on radarr/sonarr, while GET is tightly allowlisted precisely because *arr
    // config endpoints return the API key in their response body — and the
    // response is relayed verbatim. So `PUT /api/v3/config/host` handed the
    // Radarr admin key straight to the browser, defeating the whole reason the
    // key lives only in the BFF. One XSS in an admin session was enough.
    if (!user.isAdmin) return false;
    return (MUTATE_ALLOW[prefix] || []).some((re) => re.test(pathname));
  }
  return false;
}

async function handlePassthrough(req, res, prefix, restPath, user) {
  if (!isAllowedPassthrough(req.method, prefix, restPath, user)) {
    return send(res, 403, { error: 'forbidden' });
  }

  const backend = BACKENDS[prefix];
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendTooLarge(res);
      throw err;
    }
  }
  const headers = { 'X-Api-Key': backend.key };
  const contentType = req.headers['content-type'];
  if (contentType) headers['content-type'] = contentType;

  let upstream;
  try {
    upstream = await fetch(`${backend.base}${restPath}`, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return send(res, 502, { error: 'upstream unreachable' });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const out = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
  res.writeHead(upstream.status, out);
  res.end(buf);
}

// ---------------------------------------------------------------------------
// POST /bff/cancel — owner-or-admin. Server-side port of the SPA's former
// cancel chain (useCancelDownload). *arr steps are best-effort; the Jellyseerr
// request delete is the authoritative step and runs with the caller's cookie.
// ---------------------------------------------------------------------------

/**
 * Resolves a Jellyseerr request server-side using the caller's cookie: its owner
 * id AND its tmdbId. Returns null if the caller can't see it (Jellyseerr scopes
 * visibility by owner/admin). The tmdbId comes from HERE, never from the client —
 * see handleCancel.
 */
async function fetchRequestInfo(requestId, cookie) {
  try {
    const res = await fetch(`${JELLYSEERR_URL}/api/v1/request/${requestId}`, {
      headers: { cookie, accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      ownerId: Number(body?.requestedBy?.id),
      tmdbId: body?.media?.tmdbId == null ? null : Number(body.media.tmdbId),
    };
  } catch {
    return null;
  }
}

async function cancelRadarr(tmdbId) {
  try {
    const movies = await arrFetch('radarr', '/api/v3/movie');
    const movie = movies.find((m) => m.tmdbId === tmdbId);
    if (!movie) return;
    const queue = await arrFetch('radarr', '/api/v3/queue');
    const matches = (queue?.records || []).filter((r) => r.movieId === movie.id && r.id != null);
    await Promise.all(
      matches.map((r) =>
        arrFetch('radarr', `/api/v3/queue/${r.id}?removeFromClient=true&blocklist=false`, { method: 'DELETE' }),
      ),
    );
    const raw = await arrFetch('radarr', `/api/v3/movie/${movie.id}`);
    await arrFetch('radarr', `/api/v3/movie/${movie.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...raw, monitored: false }),
    });
  } catch {
    // best-effort: an empty queue / unreachable Radarr must not block the cancel.
  }
}

async function cancelSonarr(tmdbId) {
  try {
    const series = await arrFetch('sonarr', '/api/v3/series');
    const found = series.find((s) => s.tmdbId === tmdbId);
    if (!found) return;
    const queue = await arrFetch('sonarr', '/api/v3/queue');
    const matches = (queue?.records || []).filter((r) => r.seriesId === found.id && r.id != null);
    await Promise.all(
      matches.map((r) =>
        arrFetch('sonarr', `/api/v3/queue/${r.id}?removeFromClient=true&blocklist=false`, { method: 'DELETE' }),
      ),
    );
    const episodes = await arrFetch('sonarr', `/api/v3/episode?seriesId=${found.id}`);
    const pendingIds = (episodes || []).filter((e) => e.monitored && !e.hasFile).map((e) => e.id);
    if (pendingIds.length > 0) {
      await arrFetch('sonarr', '/api/v3/episode/monitor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeIds: pendingIds, monitored: false }),
      });
    }
  } catch {
    // best-effort, same rationale as cancelRadarr.
  }
}

async function handleCancel(req, res, user) {
  const cookie = req.headers.cookie || '';
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString() || '{}');
  } catch {
    return send(res, 400, { error: 'invalid json' });
  }
  const requestId = Number(payload.requestId);
  if (!Number.isFinite(requestId)) return send(res, 400, { error: 'requestId required' });

  // Resolve the request server-side: owner AND tmdbId. The client-supplied tmdbId
  // is deliberately IGNORED — trusting it lets a user pair their own requestId
  // with someone else's tmdbId and cancel arbitrary titles (the ownership check
  // only covers the requestId).
  const info = await fetchRequestInfo(requestId, cookie);
  if (!info) return send(res, 403, { error: 'forbidden' });
  if (!user.isAdmin && info.ownerId !== user.id) return send(res, 403, { error: 'forbidden' });

  // Authoritative step FIRST, with the caller's cookie so Jellyseerr re-checks
  // perms. Only after it succeeds do we touch *arr (best-effort), so an
  // unauthorized caller can never trigger a destructive side effect.
  let del;
  try {
    del = await fetch(`${JELLYSEERR_URL}/api/v1/request/${requestId}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      method: 'DELETE',
      headers: { cookie },
    });
  } catch {
    return send(res, 502, { error: 'jellyseerr unreachable' });
  }
  if (!del.ok) return send(res, del.status, { error: 'request delete failed' });

  if (info.tmdbId != null) {
    await Promise.all([cancelRadarr(info.tmdbId), cancelSonarr(info.tmdbId)]);
  }
  return send(res, 204, '');
}

// ---------------------------------------------------------------------------
// Self-service registration (invite-gated, PUBLIC) + admin user management.
// ---------------------------------------------------------------------------

/** Best-effort client IP: Caddy sets X-Forwarded-For; fall back to the socket. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Sliding-window rate limit for /bff/register: an attacker must not be able to
// brute-force invite codes. Keyed by IP, in-memory (a restart resets it, which
// is acceptable for this low-stakes, invite-gated endpoint).
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_MAX = 5;
// Per-IP is effectively per-ORIGIN behind the Funnel (every public visitor shares
// the sidecar's IP), so it has to be loose enough not to lock out a household.
const REGISTER_MAX_PER_IP = 40;
// A specific invite code, though, is only ever typed by one person: a handful of
// attempts is generous and it is what makes guessing expensive.
const REGISTER_MAX_PER_CODE = 5;
/** @type {Map<string, number[]>} */
const registerHits = new Map();

function rateLimited(key, now, max = REGISTER_MAX) {
  const hits = (registerHits.get(key) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (hits.length >= max) {
    registerHits.set(key, hits);
    return true;
  }
  hits.push(now);
  registerHits.set(key, hits);
  if (registerHits.size > 1024) {
    for (const [k, v] of registerHits) {
      if (v.every((t) => now - t >= REGISTER_WINDOW_MS)) registerHits.delete(k);
    }
  }
  return false;
}

/** Returns the parsed body, or a marker: 'too_large' | null (unparseable). */
async function parseJson(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return 'too_large';
    return null;
  }
  try {
    return JSON.parse(raw.toString() || '{}');
  } catch {
    return null;
  }
}

async function handleRegister(req, res) {
  const now = Date.now();

  // The per-IP bucket cannot carry this alone. All public traffic arrives through
  // the Tailscale Funnel sidecar, so Caddy stamps EVERY visitor with that one
  // container IP — five signups in ten minutes locked out the whole internet, and
  // one abusive client locked out the family. Per-IP is still checked (it is real
  // when reached over the LAN) but with a much higher ceiling, and the bucket that
  // actually stops brute force is keyed on the CODE being attempted: guessing is
  // per-code work, so that is where the limit belongs.
  if (rateLimited(`ip:${clientIp(req)}`, now, REGISTER_MAX_PER_IP)) {
    logError('register.rateLimit', 'per-ip limit hit', { ip: clientIp(req) });
    return send(res, 429, { error: 'too_many_requests' });
  }

  const body = await parseJson(req);
  if (body === 'too_large') return sendTooLarge(res);
  if (!body) return send(res, 400, { error: 'invalid_json' });

  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (code && rateLimited(`code:${code}`, now, REGISTER_MAX_PER_CODE)) {
    logError('register.rateLimit', 'per-code limit hit', { code });
    return send(res, 429, { error: 'too_many_requests' });
  }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const { password } = body;
  if (!code) return send(res, 400, { error: 'invalid_code' });

  const usernameErr = validateUsername(username);
  if (usernameErr) return send(res, 400, { error: 'invalid_username', message: usernameErr });
  const passwordErr = validatePassword(password);
  if (passwordErr) return send(res, 400, { error: 'invalid_password', message: passwordErr });

  // Fail fast on a bad code before touching Jellyfin (final consume is atomic).
  const pre = await checkInvite(code);
  if (!pre.ok) return send(res, 403, { error: `invite_${pre.reason}` });

  try {
    if (await userExists(username)) {
      return send(res, 409, { error: 'username_taken' });
    }
  } catch {
    return send(res, 502, { error: 'jellyfin_unreachable' });
  }

  // Create in Jellyfin, then import into Jellyseerr. If the import fails we roll
  // the Jellyfin account back so a half-provisioned user can't linger (and the
  // invite stays unused).
  let userId;
  try {
    userId = await createUser(username, password);
  } catch (err) {
    if (err.code === 'USERNAME_TAKEN') return send(res, 409, { error: 'username_taken' });
    return send(res, 502, { error: 'jellyfin_create_failed' });
  }

  try {
    await importToJellyseerr(userId, username);
  } catch {
    await deleteUser(userId).catch(() => {});
    return send(res, 502, { error: 'jellyseerr_import_failed' });
  }

  // Consume the invite last: only a fully provisioned account burns a code.
  const consumed = await consumeInvite({ code, usedBy: username, nowIso: new Date(now).toISOString() });
  if (!consumed.ok) {
    // Lost a race for the same code — the account exists but the code was just
    // used by someone else. Roll back to keep single-use honest.
    await deleteUser(userId).catch(() => {});
    return send(res, 409, { error: `invite_${consumed.reason}` });
  }

  return send(res, 201, { ok: true, username });
}

async function handleAdminInvites(req, res, user) {
  if (req.method === 'GET') {
    return send(res, 200, { invites: await listInvites() });
  }
  if (req.method === 'POST') {
    const parsed = await parseJson(req);
    if (parsed === 'too_large') return sendTooLarge(res);
    const body = parsed || {};
    let expiresInDays = null;
    if (body.expiresInDays != null) {
      expiresInDays = Number(body.expiresInDays);
      if (!Number.isFinite(expiresInDays) || expiresInDays <= 0) {
        return send(res, 400, { error: 'invalid_expiry' });
      }
    }
    const invite = await createInvite({
      createdBy: user.id,
      expiresInDays,
      nowIso: new Date().toISOString(),
    });
    return send(res, 201, invite);
  }
  return send(res, 405, { error: 'method_not_allowed' });
}

async function handleRevokeInvite(req, res, code) {
  const ok = await revokeInvite(decodeURIComponent(code));
  return ok ? send(res, 204, '') : send(res, 404, { error: 'not_found' });
}

async function handleAdminUsers(req, res) {
  try {
    return send(res, 200, { users: await listUsers() });
  } catch {
    return send(res, 502, { error: 'jellyfin_unreachable' });
  }
}

async function handleResetPassword(req, res, userId) {
  const body = await parseJson(req);
  if (body === 'too_large') return sendTooLarge(res);
  if (!body) return send(res, 400, { error: 'invalid_json' });
  const passwordErr = validatePassword(body.newPassword);
  if (passwordErr) return send(res, 400, { error: 'invalid_password', message: passwordErr });
  try {
    await setPassword(userId, body.newPassword, { fresh: false });
    return send(res, 204, '');
  } catch {
    return send(res, 502, { error: 'jellyfin_reset_failed' });
  }
}

// GET /bff/admin/storage — server media-disk usage for the Admin panel. Radarr
// already knows the disk (it manages the same /data volume) and exposes it at
// /api/v3/diskspace, so we reuse the BFF's existing admin *arr key instead of
// mounting the media volume into the BFF just to stat it. Every mount there sits
// on the same physical disk, so we prefer the /data (media) entry and fall back
// to whichever has the largest total.
async function handleAdminStorage(req, res) {
  try {
    const disks = await arrFetch('radarr', '/api/v3/diskspace');
    if (!Array.isArray(disks) || disks.length === 0) {
      return send(res, 502, { error: 'diskspace_unavailable' });
    }
    const pick =
      disks.find((d) => d.path === '/data') ??
      disks.reduce((a, b) => (b.totalSpace > a.totalSpace ? b : a));
    return send(res, 200, {
      path: pick.path,
      freeSpace: pick.freeSpace,
      totalSpace: pick.totalSpace,
    });
  } catch {
    return send(res, 502, { error: 'diskspace_unavailable' });
  }
}

// ---------------------------------------------------------------------------
// /bff/remote/* — relays the phone-as-remote keys to the projector.
//
// The projector runs a tiny listener inside the PoisonFlix app itself (see
// RemoteControlServer.kt), NOT adb: adb would hand a shell on the whole device
// to anything that can reach this relay, whereas the app listener can only
// press buttons inside that one app.
//
// Why the phone does not call the projector directly: the web app is also
// served over HTTPS through the Tailscale funnel, and an HTTPS page cannot
// call a plain-HTTP LAN address (mixed content). Going through here keeps one
// origin, reuses the session the caller already has, and means the projector's
// listener never has to be reachable from outside the LAN.
const PROJECTOR_URL = env.PROJECTOR_URL || 'http://192.168.1.63:8099';

async function handleRemote(req, res, subPath, search) {
  // Explicit allowlist rather than blind forwarding: this endpoint drives the
  // living-room screen, so the set of things it can do stays enumerable.
  const allowed = subPath === '/key' || subPath === '/text' || subPath === '/ping';
  if (!allowed) return send(res, 404, { error: 'not_found' });

  const target = `${PROJECTOR_URL}${subPath}${search || ''}`;
  try {
    const upstream = await fetch(target, {
      method: 'GET',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    const body = await upstream.text();
    return send(res, upstream.status, body ? JSON.parse(body) : {});
  } catch (err) {
    // The projector being asleep or the app being closed is the ordinary case,
    // not an incident: answer something the UI can show rather than a 500.
    logError('remote', err, { path: subPath });
    return send(res, 502, { error: 'projector_unreachable' });
  }
}

/** Short: the projector is on the LAN, and a remote that lags is worse than one that fails. */
const REMOTE_TIMEOUT_MS = 4_000;

// /bff/music/* — thin proxy to the internal music worker. Any authenticated
// user may search/download; the worker itself never faces the public and holds
// its own Jellyfin key. The worker returns clean JSON envelopes we pass through
// verbatim; an unreachable worker surfaces as a 502 the SPA can degrade on.
// ---------------------------------------------------------------------------

async function handleMusic(req, res, subPath, search, user) {
  const method = req.method;
  // Allowlist: exactly the routes the SPA needs, nothing else reaches the
  // worker. `subPath` is the part after `/bff/music`.
  const isDownloadsCollection = subPath === '/downloads';
  const isDownloadJob = /^\/downloads\/[^/]+$/.test(subPath);
  const isSearch = subPath === '/search';
  const isRecommendations = subPath === '/recommendations';
  const isPlaylistsCollection = subPath === '/playlists';
  const isPlaylistBatch = /^\/playlists\/[^/]+$/.test(subPath);
  // Instant-play: the worker streams the audio for a videoId without downloading.
  const isStream = subPath === '/stream';
  // The tracks inside an album/playlist, so a collection can be played or
  // queued without downloading it first.
  const isCollection = subPath === '/collection';
  // Thumbs up/down. GET reads this user's votes, POST casts one.
  const isRatings = subPath === '/ratings';
  // Preview listening tally. Previews have no Jellyfin item to bump a
  // PlayCount on, so the worker keeps the count keyed by videoId instead.
  const isPlays = subPath === '/plays';

  let ok = false;
  if (
    method === 'GET' &&
    (isSearch ||
      isRecommendations ||
      isDownloadsCollection ||
      isDownloadJob ||
      isPlaylistBatch ||
      isStream ||
      isCollection ||
      isRatings ||
      isPlays)
  ) {
    ok = true;
  }
  if (
    method === 'POST' &&
    (isDownloadsCollection || isPlaylistsCollection || isRatings || isPlays)
  ) {
    ok = true;
  }
  if (!ok) return send(res, 404, { error: 'not found' });

  let body;
  if (method === 'POST') {
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendTooLarge(res);
      throw err;
    }
  }
  const headers = {};
  const contentType = req.headers['content-type'];
  if (contentType) headers['content-type'] = contentType;
  // Forward Range so audio seeking works end to end (browser -> BFF -> worker).
  if (req.headers['range']) headers['range'] = req.headers['range'];
  // The worker cannot authenticate anyone: it sits on the internal network and
  // only the BFF holds the session. Ratings are per user, so the resolved id is
  // injected here — never taken from anything the browser sent.
  headers['x-pf-user'] = String(user.id);

  let upstream;
  try {
    upstream = await fetch(`${MUSIC_WORKER_URL}${subPath}${search || ''}`, {
      method,
      headers,
      body,
      // NOT on the stream. AbortSignal.timeout covers the whole operation
      // INCLUDING reading the body, so a total timeout would cut playback off
      // mid-track — a track outlasts any sane request budget. The stream path is
      // protected instead by the pipeline error handling below.
      signal: isStream ? undefined : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return send(res, 502, { error: 'music_worker_unreachable' });
  }

  // Audio stream: pipe the body straight through (never buffer a whole track),
  // preserving status (200/206) and the Range/length headers for seeking.
  if (isStream) {
    const passthrough = {};
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const value = upstream.headers.get(h);
      if (value) passthrough[h] = value;
    }
    passthrough['cache-control'] = 'no-store';
    res.writeHead(upstream.status, passthrough);
    if (upstream.body) {
      // `pipeline`, not `.pipe()`. `.pipe()` does not forward source errors, and
      // with no 'error' listener and no process guard a mid-track failure became
      // an uncaughtException that KILLED THE BFF — taking every in-flight
      // /radarr, /sonarr, /prowlarr and /bff request with it, plus the auth cache
      // and the register rate-limit state. The worker closing a stream (a client
      // seek, a restart, an expired googlevideo URL) is routine, so this was a
      // routine full-service outage that `restart: unless-stopped` disguised as
      // an intermittent blip. Headers are already sent here, so there is nothing
      // to report to the client but the socket teardown; the point is that the
      // process survives and the failure gets logged.
      const { pipeline } = await import('node:stream/promises');
      const { Readable } = await import('node:stream');
      try {
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch (err) {
        // `subPath`, not `url` — handleMusic never receives a URL object, so the
        // first version of this line threw a ReferenceError from inside the error
        // handler itself. The router then tried to answer 500 on a response whose
        // headers were already sent, which surfaced as an unhandledRejection. Found
        // by driving a real seek in the browser, caught by the very logging this
        // block adds.
        logError('music.stream', err, { path: subPath });
        res.destroy();
      }
    } else {
      res.end();
    }
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
  });
  res.end(buf);
}

// ---------------------------------------------------------------------------
// Jam — listening together
// ---------------------------------------------------------------------------

// Every write returns a reason string rather than throwing, so the mapping to
// status codes lives here once instead of in a dozen handlers.
const JAM_STATUS = {
  not_found: 404,
  not_member: 403,
  not_invited: 403,
  forbidden: 403,
  owner_cannot_leave: 409,
  already_member: 409,
  jam_full: 409,
  queue_full: 409,
  end_of_queue: 409,
  start_of_queue: 409,
  bad_role: 400,
  bad_mode: 400,
  bad_index: 400,
  bad_position: 400,
  bad_command: 400,
};

function sendJam(res, outcome) {
  if (outcome.ok) return send(res, 200, { jam: outcome.jam });
  return send(res, JAM_STATUS[outcome.reason] ?? 400, { error: outcome.reason });
}

/**
 * The minimal user directory a Jam invite needs: id and display name, nothing
 * else.
 *
 * Deliberately NOT `listUsers()` from identity.mjs, which is the admin list
 * and comes from Jellyfin. Two reasons. It carries `isAdmin`, `hasPassword`
 * and `lastActivityDate`, none of which a peer should learn from a search box;
 * and its ids are Jellyfin GUIDs, while `resolveUser` authenticates Jellyseerr
 * numeric ids. Keying membership off the wrong one would produce a room whose
 * members can never be recognised as themselves.
 *
 * Jellyseerr's own list is queried with the CALLER's cookie, so the directory
 * can never show more than that person is already entitled to see.
 */
async function jamDirectory(req, excludeUserId) {
  const upstream = await fetch(`${JELLYSEERR_URL}/api/v1/user?take=200`, {
    headers: { cookie: req.headers.cookie || '', accept: 'application/json' },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  if (!upstream.ok) return null;
  const body = await upstream.json();
  return (body?.results ?? [])
    .map((u) => ({
      userId: String(u.id),
      name: String(u.displayName || u.username || u.email || u.id),
    }))
    // No point offering to invite yourself to your own room.
    .filter((u) => u.userId !== String(excludeUserId));
}

async function handleJamUsers(req, res, user) {
  // Enumerating everyone's name used to require the admin bit
  // (`/bff/admin/users`), so handing it to every logged-in account would be a
  // new capability granted as a side effect of shipping Jam. Owning a room is
  // the smallest thing that makes the directory necessary, and creating one
  // needs no directory at all — so the flow still works and a user who never
  // starts a Jam gains nothing.
  const mine = await listJamsForUser(String(user.id));
  if (!mine.some((entry) => entry.jam.ownerId === String(user.id))) {
    return send(res, 403, { error: 'forbidden' });
  }
  const users = await jamDirectory(req, user.id);
  if (!users) return send(res, 502, { error: 'directory_unavailable' });
  return send(res, 200, { users });
}

/**
 * The live channel. The connection IS the presence: opening it puts you in the
 * room, closing it takes you out, and that is what makes leadership fall out
 * of who is connected rather than needing to be tracked separately.
 *
 * SSE rather than a WebSocket because this server has no dependencies and
 * intends to keep it that way — `text/event-stream` is plain HTTP, and the
 * upstream direction is an ordinary POST, which doubles as the round trip a
 * follower measures its clock offset with.
 */
async function handleJamStream(req, res, jamId, user) {
  const snapshot = await jamSnapshot(jamId);
  if (!snapshot) return send(res, 404, { error: 'not_found' });
  const userId = String(user.id);
  const member = snapshot.jam.members.find((m) => m.userId === userId);
  // A pending invitee may watch the room they were invited to; a stranger may
  // not learn it exists.
  if (!member) return send(res, 403, { error: 'forbidden' });

  // Only an accepted member counts as being in the room — otherwise opening
  // an invitation would make the invitee eligible to lead a jam they have not
  // joined. Attach BEFORE the headers go out: refusing after a 200 has been
  // written leaves the client believing it has a live stream.
  let detach = () => {};
  if (member.acceptedAt !== null) {
    const attached = jamAttach(jamId, userId, res);
    if (!attached) return send(res, 429, { error: 'too_many_streams' });
    detach = attached;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Caddy does not buffer by default, but a future proxy in front of it
    // would, and a buffered event stream is an event stream that never
    // arrives.
    'x-accel-buffering': 'no',
  });

  // Send the room before anything changes, so the client renders immediately
  // instead of waiting for someone else to press a button.
  res.write(`data: ${JSON.stringify(await jamSnapshot(jamId))}\n\n`);

  // Comment-only heartbeat: keeps intermediaries from reaping an idle
  // connection, and costs nothing to parse on the client.
  const beat = setInterval(() => {
    try {
      res.write(': beat\n\n');
    } catch {
      /* the close handler cleans up */
    }
  }, 20_000);

  const cleanUp = () => {
    clearInterval(beat);
    detach();
  };
  req.on('close', cleanUp);
  req.on('error', cleanUp);
}

async function handleJam(req, res, subPath, url, user) {
  const userId = String(user.id);

  // The clock a follower measures its offset against. Deliberately the
  // cheapest possible handler: the round trip is the measurement, so anything
  // slow here becomes error in someone's playhead.
  if (subPath === '/time' && req.method === 'GET') {
    return send(res, 200, { now: Date.now() });
  }

  if (subPath === '/users' && req.method === 'GET') {
    return await handleJamUsers(req, res, user);
  }

  if (subPath === '' || subPath === '/') {
    if (req.method === 'GET') return send(res, 200, { jams: await listJamsForUser(userId) });
    if (req.method === 'POST') {
      const body = await parseJson(req);
      if (body === 'too_large') return send(res, 413, { error: 'body_too_large' });
      if (!body) return send(res, 400, { error: 'bad_json' });
      // The display name comes from the session rather than the request: a
      // client that could name itself could impersonate someone in the member
      // list.
      const me = await meDisplayName(req, userId);
      return sendJam(res, await createJam({
        ownerId: userId,
        ownerName: me,
        name: body.name,
        mode: body.mode,
      }));
    }
    return send(res, 405, { error: 'method_not_allowed' });
  }

  const stream = subPath.match(/^\/([^/]+)\/stream$/);
  if (stream && req.method === 'GET') {
    return await handleJamStream(req, res, stream[1], user);
  }

  const action = subPath.match(/^\/([^/]+)\/([a-z-]+)$/);
  if (!action || req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const [, jamId, verb] = action;

  const body = await parseJson(req);
  if (body === 'too_large') return send(res, 413, { error: 'body_too_large' });
  if (!body) return send(res, 400, { error: 'bad_json' });

  switch (verb) {
    case 'invite': {
      // Names come from the directory, never from the request. `createJam`
      // already refuses to let a client name its own creator; letting one name
      // OTHER people would be worse — whoever invites would control how a
      // member is labelled inside that room for good.
      const wanted = (Array.isArray(body.users) ? body.users : []).map((u) => String(u.userId));
      const directory = await jamDirectory(req, userId);
      if (!directory) return send(res, 502, { error: 'directory_unavailable' });
      const known = new Map(directory.map((u) => [u.userId, u.name]));
      const resolved = wanted.filter((id) => known.has(id)).map((id) => ({ userId: id, name: known.get(id) }));
      return sendJam(res, await inviteMembers(jamId, userId, resolved));
    }
    case 'kick':
      return sendJam(res, await removeMember(jamId, userId, String(body.userId)));
    case 'respond':
      return sendJam(res, await respondToInvite(jamId, userId, body.accept === true));
    case 'leave':
      return sendJam(res, await leaveJam(jamId, userId));
    case 'role':
      return sendJam(res, await setRole(jamId, userId, String(body.userId), body.role));
    case 'owner':
      return sendJam(res, await transferOwnership(jamId, userId, String(body.userId)));
    case 'mode':
      return sendJam(res, await setMode(jamId, userId, body.mode));
    case 'queue':
      return sendJam(res, await addTracks(jamId, userId, Array.isArray(body.tracks) ? body.tracks : []));
    case 'unqueue':
      return sendJam(res, await removeTrack(jamId, userId, body.index));
    case 'transport':
      return sendJam(res, await transport(jamId, userId, body));
    default:
      return send(res, 404, { error: 'not found' });
  }
}

/** The caller's display name, straight from Jellyseerr, so a member list can
 *  never be seeded with a name the client made up. */
async function meDisplayName(req, fallback) {
  try {
    const upstream = await fetch(`${JELLYSEERR_URL}/api/v1/auth/me`, {
      headers: { cookie: req.headers.cookie || '', accept: 'application/json' },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!upstream.ok) return fallback;
    const body = await upstream.json();
    return String(body?.displayName || body?.username || fallback);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://bff');
    const path = url.pathname;

    if (path === '/healthz') return send(res, 200, { ok: true });

    // CSRF. Auth is purely the ambient `connect.sid` cookie, so a page on another
    // origin could drive any mutation here — cancel a request, queue a download,
    // mint or revoke an invite, reset a password. In practice Jellyseerr's session
    // cookie defaults to SameSite=Lax, which blocks cross-site POST, but the BFF
    // neither sets that cookie nor verifies it: the entire protection was an
    // upstream default it had no say over.
    //
    // Compared against the request's own Host rather than a configured list, so it
    // holds for localhost, the LAN IP and the Funnel hostname without knowing any
    // of them. Only a PRESENT and mismatched Origin is refused — a browser always
    // sends Origin on a cross-origin mutation, while non-browser clients may omit
    // it entirely, and rejecting the absent case would break them for no gain.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (!originHost || originHost !== req.headers.host) {
          logError('csrf', 'origin mismatch', { origin, host: req.headers.host, path });
          return send(res, 403, { error: 'bad_origin' });
        }
      }
    }

    // PUBLIC: invite-gated self-service registration. Must be reachable without a
    // session (the caller has no account yet). Everything below this line requires
    // an authenticated Jellyseerr session.
    if (path === '/bff/register' && req.method === 'POST') {
      return await handleRegister(req, res);
    }

    // Client diagnostics. The duration defect only reproduces on the reporter's
    // iPhone — never in headless Chromium, with or without Range — so the numbers
    // that would identify it live in a browser nobody can attach a debugger to.
    // window.__pfErrors is unreachable on a phone in practice, so the same payload
    // is posted here and lands in `docker compose logs bff`. Public on purpose: it
    // has to work before the session is established, it writes nothing, and the
    // body is capped by readBody's 1 MB limit like every other route.
    if (path === '/bff/client-log' && req.method === 'POST') {
      const body = await parseJson(req);
      if (body === 'too_large') return sendTooLarge(res);
      const scope = body?.scope || 'unknown';
      const detail = {
        message: body?.message ?? null,
        detail: body?.detail ?? null,
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
      };
      logError('client', scope, detail); // stdout — greppable via `docker logs poisonflix-bff | grep '"scope":"client"'`
      // Fire-and-forget: `persistClientLog` never throws/rejects, and a public
      // diagnostics endpoint must not make the caller wait on disk I/O.
      void persistClientLog({ at: new Date().toISOString(), scope, ...detail });
      return send(res, 204, '');
    }

    const user = await resolveUser(req.headers.cookie || '');
    if (!user) return send(res, 401, { error: 'unauthenticated' });

    // ADMIN: user & invite management. Gated by the Jellyseerr admin permission
    // bit, re-checked server-side on every call (never trust the SPA's flag).
    if (path.startsWith('/bff/admin/')) {
      if (!user.isAdmin) return send(res, 403, { error: 'forbidden' });
      if (path === '/bff/admin/invites') return await handleAdminInvites(req, res, user);
      const revoke = path.match(/^\/bff\/admin\/invites\/([^/]+)$/);
      if (revoke && req.method === 'DELETE') return await handleRevokeInvite(req, res, revoke[1]);
      if (path === '/bff/admin/users' && req.method === 'GET') {
        return await handleAdminUsers(req, res);
      }
      if (path === '/bff/admin/storage' && req.method === 'GET') {
        return await handleAdminStorage(req, res);
      }
      const reset = path.match(/^\/bff\/admin\/users\/([^/]+)\/reset-password$/);
      if (reset && req.method === 'POST') return await handleResetPassword(req, res, reset[1]);
      return send(res, 404, { error: 'not found' });
    }

    if (path === '/bff/cancel' && req.method === 'POST') {
      return await handleCancel(req, res, user);
    }

    // Música: any authenticated user may search + enqueue downloads.
    if (path.startsWith('/bff/remote/')) {
      return await handleRemote(req, res, path.slice('/bff/remote'.length), url.search);
    }

    if (path.startsWith('/bff/music/')) {
      return await handleMusic(req, res, path.slice('/bff/music'.length), url.search, user);
    }

    if (path === '/bff/jam' || path.startsWith('/bff/jam/')) {
      return await handleJam(req, res, path.slice('/bff/jam'.length), url, user);
    }

    const seg = path.split('/'); // ['', 'radarr', 'api', ...]
    const prefix = seg[1];
    if (BACKENDS[prefix]) {
      const restPath = path.slice(prefix.length + 1) + (url.search || '');
      return await handlePassthrough(req, res, prefix, restPath, user);
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    // This answered 500 with no trace at all, so an internal error was
    // indistinguishable from a working endpoint returning nothing.
    logError('router', err, { method: req.method, url: req.url });
    return send(res, 500, { error: 'internal' });
  }
});

// Backstop. The stream pipeline above is the known crasher and is handled at the
// source, but an unguarded process exits on ANY stray async error and every
// in-flight request dies with it. Rejections are logged and survived; an
// uncaughtException leaves the process in an unknown state, so it is logged and
// then allowed to exit for Docker to restart — the difference from before is
// that there is now a line saying why.
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  process.exit(1);
});

server.listen(Number(PORT), () => {
  // eslint-disable-next-line no-console
  console.log(`poisonflix-bff listening on :${PORT}`);
});
