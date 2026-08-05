// poisonflix-bff — the ONLY component that holds the *arr admin API keys and the
// only thing Caddy routes /prowlarr /radarr /sonarr /bff to. Every request is
// authenticated against the caller's Jellyseerr session (the same-origin
// `connect.sid` cookie) before any backend is touched. Authorization lives here,
// on the server — the SPA is never trusted (see design.md "Threat model").
//
// Zero runtime dependencies: Node's built-in http + global fetch (Node >= 18).

import { createServer } from 'node:http';

import {
  createInvite,
  listInvites,
  revokeInvite,
  consumeInvite,
  checkInvite,
} from './invites.mjs';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from './watchlist.mjs';
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

const {
  PORT = '8787',
  JELLYSEERR_URL = 'http://jellyseerr:5055',
  RADARR_URL = 'http://radarr:7878',
  SONARR_URL = 'http://sonarr:8989',
  PROWLARR_URL = 'http://prowlarr:9696',
  RADARR_API_KEY = '',
  SONARR_API_KEY = '',
  PROWLARR_API_KEY = '',
} = process.env;

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
  if (authCache.size > 512) pruneAuthCache(now);
  return user;
}

function pruneAuthCache(now) {
  for (const [k, v] of authCache) if (v.exp <= now) authCache.delete(k);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A *arr call the BFF makes itself, with the admin key. Returns parsed JSON or null. */
async function arrFetch(backendKey, path, init = {}) {
  const backend = BACKENDS[backendKey];
  const res = await fetch(`${backend.base}${path}`, {
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

function isAllowedPassthrough(method, prefix, restPath, user) {
  const pathname = restPath.split('?')[0];
  if (method === 'GET') {
    return (GET_ALLOW[prefix] || []).some((re) => re.test(pathname));
  }
  if (method === 'POST' && prefix === 'prowlarr' && pathname === '/api/v1/search') {
    return true; // grab / "Pedir"
  }
  if ((method === 'DELETE' || method === 'PUT') && (prefix === 'radarr' || prefix === 'sonarr')) {
    return user.isAdmin; // library delete / monitor toggles
  }
  return false;
}

async function handlePassthrough(req, res, prefix, restPath, user) {
  if (!isAllowedPassthrough(req.method, prefix, restPath, user)) {
    return send(res, 403, { error: 'forbidden' });
  }

  const backend = BACKENDS[prefix];
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const headers = { 'X-Api-Key': backend.key };
  const contentType = req.headers['content-type'];
  if (contentType) headers['content-type'] = contentType;

  let upstream;
  try {
    upstream = await fetch(`${backend.base}${restPath}`, { method: req.method, headers, body });
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
/** @type {Map<string, number[]>} */
const registerHits = new Map();

function rateLimited(ip, now) {
  const hits = (registerHits.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (hits.length >= REGISTER_MAX) {
    registerHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  registerHits.set(ip, hits);
  if (registerHits.size > 1024) {
    for (const [k, v] of registerHits) {
      if (v.every((t) => now - t >= REGISTER_WINDOW_MS)) registerHits.delete(k);
    }
  }
  return false;
}

async function parseJson(req) {
  try {
    return JSON.parse((await readBody(req)).toString() || '{}');
  } catch {
    return null;
  }
}

async function handleRegister(req, res) {
  const now = Date.now();
  if (rateLimited(clientIp(req), now)) {
    return send(res, 429, { error: 'too_many_requests' });
  }

  const body = await parseJson(req);
  if (!body) return send(res, 400, { error: 'invalid_json' });

  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
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
    await importToJellyseerr(userId);
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
    const body = (await parseJson(req)) || {};
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
// "Mi lista" (watchlist): per-user saved titles to request/download later.
// Identity comes from `user.id` (the resolved Jellyseerr user), NEVER the
// request body - so a user can only ever touch their own list.
const MEDIA_TYPES = new Set(['movie', 'tv']);

async function handleWatchlist(req, res, user, subPath) {
  // GET /bff/watchlist -> the caller's saved titles.
  if (subPath === '' && req.method === 'GET') {
    const items = await getWatchlist(user.id);
    return send(res, 200, { items });
  }

  // POST /bff/watchlist  { tmdbId, mediaType, title, posterPath }
  if (subPath === '' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)).toString() || '{}');
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    const tmdbId = Number(payload.tmdbId);
    const mediaType = payload.mediaType;
    if (!Number.isFinite(tmdbId)) return send(res, 400, { error: 'tmdbId required' });
    if (!MEDIA_TYPES.has(mediaType)) return send(res, 400, { error: 'mediaType must be movie|tv' });
    const entry = {
      tmdbId,
      mediaType,
      title: typeof payload.title === 'string' ? payload.title : 'Sin título',
      posterPath: typeof payload.posterPath === 'string' ? payload.posterPath : null,
    };
    const items = await addToWatchlist(user.id, entry, new Date().toISOString());
    return send(res, 200, { items });
  }

  // DELETE /bff/watchlist/{mediaType}/{tmdbId}
  const del = subPath.match(/^\/(movie|tv)\/(\d+)$/);
  if (del && req.method === 'DELETE') {
    const items = await removeFromWatchlist(user.id, Number(del[2]), del[1]);
    return send(res, 200, { items });
  }

  return send(res, 404, { error: 'not found' });
}

// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://bff');
    const path = url.pathname;

    if (path === '/healthz') return send(res, 200, { ok: true });

    // PUBLIC: invite-gated self-service registration. Must be reachable without a
    // session (the caller has no account yet). Everything below this line requires
    // an authenticated Jellyseerr session.
    if (path === '/bff/register' && req.method === 'POST') {
      return await handleRegister(req, res);
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

    // Mi lista (watchlist): /bff/watchlist and /bff/watchlist/{mediaType}/{tmdbId}.
    if (path === '/bff/watchlist' || path.startsWith('/bff/watchlist/')) {
      return await handleWatchlist(req, res, user, path.slice('/bff/watchlist'.length));
    }

    const seg = path.split('/'); // ['', 'radarr', 'api', ...]
    const prefix = seg[1];
    if (BACKENDS[prefix]) {
      const restPath = path.slice(prefix.length + 1) + (url.search || '');
      return await handlePassthrough(req, res, prefix, restPath, user);
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: 'internal' });
  }
});

server.listen(Number(PORT), () => {
  // eslint-disable-next-line no-console
  console.log(`poisonflix-bff listening on :${PORT}`);
});
