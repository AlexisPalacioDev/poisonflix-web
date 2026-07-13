// poisonflix-bff — the ONLY component that holds the *arr admin API keys and the
// only thing Caddy routes /prowlarr /radarr /sonarr /bff to. Every request is
// authenticated against the caller's Jellyseerr session (the same-origin
// `connect.sid` cookie) before any backend is touched. Authorization lives here,
// on the server — the SPA is never trusted (see design.md "Threat model").
//
// Zero runtime dependencies: Node's built-in http + global fetch (Node >= 18).

import { createServer } from 'node:http';

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
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://bff');
    const path = url.pathname;

    if (path === '/healthz') return send(res, 200, { ok: true });

    const user = await resolveUser(req.headers.cookie || '');
    if (!user) return send(res, 401, { error: 'unauthenticated' });

    if (path === '/bff/cancel' && req.method === 'POST') {
      return await handleCancel(req, res, user);
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
