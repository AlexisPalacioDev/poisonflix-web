// poisonflix-bff cast — "ver en la tele": an authenticated proxy in front of
// the cast-bridge container.
//
// Discovery does NOT live in this process, and that extra hop is the whole
// point. A container on a docker BRIDGE network discovers exactly 0 devices
// over SSDP — measured, not assumed: the M-SEARCH datagram to 239.255.255.250
// never leaves the bridge namespace, so no TV ever answers. cast-bridge runs
// with `network_mode: host`, which puts it on the real LAN where multicast
// works. The BFF cannot follow it there: `network_mode: host` is mutually
// exclusive with `networks:`, and this service NEEDS those networks to resolve
// jellyseerr/radarr/sonarr/prowlarr/jellyfin-ts by name. So it proxies.
//
// Because of that same exclusivity, cast-bridge has no service name on any
// docker network and cannot be dialled as `http://cast-bridge:8791`. It is
// reached at the docker GATEWAY address instead — the host's own IP on the
// bridge, which every container on that bridge can route to. That address is
// per-host and per-network, so it is configuration (CAST_BRIDGE_URL), never a
// constant baked in here. See the comments in docker-compose.yml.
//
// The handler lives HERE rather than in server.mjs for the reason games.mjs
// documents at length: server.mjs calls `server.listen()` at import time, so a
// test that imports it opens a real socket and reaches for a real Jellyseerr.
// A plain module lets `node --test` drive real HTTP through the exact code
// production runs, which is how the "bridge is down" path below is actually
// proven rather than reasoned about.
//
// Zero dependencies, like the rest of this service.

// Read at import time, same convention as games.mjs's GAMES_DIR and jam.mjs's
// JAM_FILE. Empty means "casting is not deployed on this host", which is a
// supported configuration and NOT an error — see handleCast.
const CAST_BRIDGE_URL = (process.env.CAST_BRIDGE_URL || '').replace(/\/+$/, '');

// A full SSDP + mDNS sweep genuinely takes seconds: the bridge waits out the
// M-SEARCH reply window and then fetches and parses one descriptor XML per
// responder. A budget tight enough to feel snappy would simply turn every real
// scan into an empty shelf, which is the exact failure this file exists to make
// impossible to confuse with "no TVs on this LAN".
const SCAN_TIMEOUT_MS = 12_000;

// Playback control is a different shape of wait. The webOS adapter opens a
// WebSocket and, on a first-ever pairing, the TV puts a confirmation dialog on
// screen; the bridge answers `needsPairing` rather than blocking on the human,
// but the handshake before that still costs seconds on a sleepy TV.
const CONTROL_TIMEOUT_MS = 15_000;

// The largest legal body here is `{ deviceId, appUrl, mediaUrl, title }` —
// well under a kilobyte. server.mjs caps at 1 MB because it also carries whole
// *arr movie objects; nothing on this route has any business being that big,
// and a smaller cap means less to buffer on a route that a browser can reach.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Exactly what may be asked of the bridge, and with which verb.
 *
 * An allowlist rather than a blind prefix forward, for the same reason
 * handleMusic keeps one: the bridge speaks SSAP, DIAL, DLNA and Cast to devices
 * on the owner's LAN and sits behind no auth of its own. Everything it can be
 * made to do from the public internet has to stay enumerable on one screen.
 * The allowlist only holds because neither fetch below follows redirects; see
 * the `redirect: 'error'` comment in sendCommand for what happens without it.
 *
 * `/healthz` is deliberately absent. Nothing in this repo consumes it (there is
 * no healthcheck in docker-compose.yml), and proxying it would publish a
 * liveness oracle for a service on the owner's LAN to anyone with a session.
 */
const ROUTES = new Map([
  ['/devices', 'GET'],
  ['/play', 'POST'],
  ['/stop', 'POST'],
]);

// Same one-line JSON shape server.mjs logs with (see `logError` there).
// Duplicated rather than imported because importing server.mjs starts a
// listening socket — the very thing this module is kept separate to avoid.
function logError(scope, err, detail) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ at: new Date().toISOString(), level: 'error', scope, message, ...detail }),
  );
}

// Scope -> { until, suppressed }. The device list is polled while the cast
// sheet is open, so an unreachable bridge would otherwise emit a line every few
// seconds and bury every other scope in `docker compose logs bff`. Silence is
// not the alternative — this repo has a whole file of scars about degradation
// nobody could see — so the first failure is always logged immediately and the
// window close-out reports how many followed it.
const throttled = new Map();
const LOG_WINDOW_MS = 60_000;

function logThrottled(scope, err, detail) {
  const now = Date.now();
  const state = throttled.get(scope);
  if (state && now < state.until) {
    state.suppressed += 1;
    return;
  }
  logError(scope, err, { ...detail, ...(state?.suppressed ? { repeated: state.suppressed } : {}) });
  throttled.set(scope, { until: now + LOG_WINDOW_MS, suppressed: 0 });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Answer an over-sized upload without tearing the socket down first.
 *
 * `Connection: close` is what ends the upload, not `req.destroy()`: destroying
 * the request beat the response to the wire and the client saw a bare `100`
 * that Caddy turned into a 502. server.mjs carries the same scar in
 * `sendTooLarge`; it is repeated here because this module must not import it.
 */
function sendTooLarge(res) {
  res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
  res.end(JSON.stringify({ error: 'body too large' }));
}

/**
 * The request body, or null when it exceeded MAX_BODY_BYTES.
 *
 * Event listeners rather than `for await (const chunk of req)`, and that is not
 * a style preference. Leaving a `for await` loop early DESTROYS the stream —
 * Node calls the iterator's `return()`, which destroys the request — and that
 * is precisely the mistake sendTooLarge above exists to document: the socket
 * dies before the 413 can flush, so the caller sees a bare `100` and Caddy
 * turns it into a 502. It is a race, so on a fast loopback it looks like it
 * works, which is how it would survive a test suite.
 *
 * `pause()` is what bounds the memory: the flow stops and nothing more is
 * buffered, while the socket stays alive long enough to answer properly.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The device list, which NEVER fails.
 *
 * Every way this can go wrong — casting not deployed on this host, the bridge
 * container down or still booting, a timed-out scan, a garbled answer — lands
 * on the same `{ devices: [] }` with HTTP 200. That is a contract, not a
 * shortcut: the player screen asks for this list while a film is on screen, and
 * a 5xx there would degrade watching a movie because nobody happened to be
 * casting it. An empty shelf is the honest answer to "what can I cast to right
 * now", and it is the same answer a working bridge gives on a LAN with no TVs.
 *
 * The two are indistinguishable to the SPA on purpose, so the difference is
 * pushed into the log instead of into the UI — which is why none of the
 * branches below are silent.
 */
async function sendDevices(res) {
  if (!CAST_BRIDGE_URL) {
    // Not an error: a deploy without a cast-bridge is a supported shape. Worth
    // one throttled line all the same, because "casting shows nothing" and
    // "casting was never wired up on this host" look identical from a phone,
    // and this is the only place that can tell them apart.
    logThrottled('cast.unconfigured', 'CAST_BRIDGE_URL is not set', {});
    return sendJson(res, 200, { devices: [] });
  }

  let upstream;
  try {
    upstream = await fetch(`${CAST_BRIDGE_URL}/devices`, {
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      // See sendCommand: following a redirect would make the allowlist a lie.
      redirect: 'error',
    });
  } catch (err) {
    // The ordinary case is ECONNREFUSED: the bridge binds to the docker gateway
    // address, so a wrong CAST_BRIDGE_URL (the gateway IP is per-host — see
    // docker-compose.yml) fails exactly like a stopped container. The log line
    // carries the URL for that reason.
    logThrottled('cast.devices', err, { bridge: CAST_BRIDGE_URL });
    return sendJson(res, 200, { devices: [] });
  }

  if (!upstream.ok) {
    logThrottled('cast.devices', `bridge answered ${upstream.status}`, { bridge: CAST_BRIDGE_URL });
    return sendJson(res, 200, { devices: [] });
  }

  let body;
  try {
    body = await upstream.json();
  } catch (err) {
    logThrottled('cast.devices', err, { bridge: CAST_BRIDGE_URL });
    return sendJson(res, 200, { devices: [] });
  }

  // The ENVELOPE is checked; the devices inside it are not. Be precise about
  // what that buys, because it is easy to overclaim: this guarantees the SPA
  // always receives `{ devices: [...] }` and never a 5xx, so a missing or
  // broken bridge degrades to an empty shelf. It does NOT guarantee every
  // element satisfies the SPA's Zod schema — a bridge that answered
  // `{ devices: [{}] }` would still fail validation client-side.
  //
  // Re-validating each device here was considered and rejected: the field set
  // and the protocol/capability enums are cast-bridge's contract, and a copy of
  // them in this file would silently drop any device a newer bridge learned to
  // find. A drifting filter that hides devices is worse than a Zod error that
  // names the problem.
  if (!body || !Array.isArray(body.devices)) {
    logThrottled('cast.devices', 'bridge answered an unexpected shape', {
      bridge: CAST_BRIDGE_URL,
    });
    return sendJson(res, 200, { devices: [] });
  }

  // Device objects pass through verbatim: cast-bridge is the authority on their
  // shape (id/name/address/protocol/capability/reason), and re-mapping them
  // here would be a second, drifting copy of that contract.
  return sendJson(res, 200, { devices: body.devices });
}

/**
 * `/play` and `/stop`, which absolutely DO fail.
 *
 * The opposite call to sendDevices, and deliberately so. Someone pressed a
 * button and expects a picture on a television; answering 200 when the bridge
 * never heard about it would leave them staring at a TV that is never going to
 * change, with nothing on screen to say why. Degrading quietly is right for a
 * list nobody asked for and wrong for a command somebody issued.
 */
async function sendCommand(req, res, subPath) {
  if (!CAST_BRIDGE_URL) {
    // NOT throttled, unlike the /devices side. A command is a person pressing a
    // button — rare, and never noise. Sharing a throttle key with a list the UI
    // polls every few seconds would let the poll swallow the log line for a
    // failed command, in a function whose entire premise is that commands fail
    // audibly.
    logError('cast.command', 'CAST_BRIDGE_URL is not set', { path: subPath });
    return sendJson(res, 503, { error: 'cast_bridge_unconfigured' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    // A client that hung up mid-upload. Ordinary, and it must not reach the
    // router's catch-all, which would answer 500 under scope 'router' and make
    // an abandoned request look like a defect in this service.
    logError('cast.command', err, { path: subPath });
    return sendJson(res, 400, { error: 'bad_request' });
  }
  if (body === null) return sendTooLarge(res);

  let upstream;
  try {
    upstream = await fetch(`${CAST_BRIDGE_URL}${subPath}`, {
      method: 'POST',
      // Forwarded rather than asserted: the bridge owns the request schema, and
      // parsing the JSON here only to re-serialise it would add a second place
      // that has to agree with it.
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body,
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      // Do NOT follow redirects. Left at the default (`follow`), a single 3xx
      // from whatever answers on port 8791 turns this route into an SSRF with
      // the request body attached: undici re-POSTs it to the Location and this
      // function hands the answer back to the browser verbatim. The BFF sits on
      // media-automation AND jellyfin-server_default, so the reachable set is
      // radarr, sonarr, prowlarr, jellyseerr and jellyfin — the exact services
      // whose API keys this process exists to keep away from the client.
      //
      // That is not hypothetical here: cast-bridge listens on a HOST port
      // (host networking, see docker-compose.yml), so any process on the host
      // that grabs 8791 first becomes the upstream, and nothing authenticates
      // it. `error` makes a redirect a failed fetch — the 502 below — instead
      // of a pivot. The route allowlist above is only true with this line.
      redirect: 'error',
    });

    // INSIDE the try, and it was not at first. `arrayBuffer()` is where a
    // bridge that sent headers and then died — or ran out the timeout partway
    // through the body — actually rejects. One line lower, that rejection
    // escaped to the router's catch-all and became `500 internal` under scope
    // 'router', contradicting the contract this very function documents. No
    // test could see it, because the stub bridge always finished its response.
    const buf = Buffer.from(await upstream.arrayBuffer());

    // Status and body pass through untouched. `needsPairing: true` is the
    // reason this matters: it arrives on a 200 and means "the TV is asking the
    // viewer to confirm, try again in a moment" — not a failure. Anything that
    // normalised these answers would have to understand that distinction, and
    // getting it wrong turns a two-second pairing prompt into a dead button.
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(buf);
  } catch (err) {
    logError('cast.command', err, { bridge: CAST_BRIDGE_URL, path: subPath });
    // `headersSent` guards the half-written case: if writeHead already ran, the
    // status line is gone and the only honest move left is to drop the socket.
    if (res.headersSent) return res.destroy();
    return sendJson(res, 502, { error: 'cast_bridge_unreachable' });
  }
}

/**
 * `/bff/cast/*`. `subPath` is the part after `/bff/cast`, and the caller has
 * already been authenticated — this module never sees a session and must never
 * be mounted above `resolveUser`. CSRF on the two mutations is likewise the
 * router's Origin check, which runs before any dispatch.
 *
 * No query string is accepted or forwarded: none of the three routes takes one,
 * and forwarding an unvalidated one would widen what a browser can hand to a
 * service that talks to the owner's television.
 */
export async function handleCast(req, res, subPath) {
  const expected = ROUTES.get(subPath);
  // A method mismatch answers 404 rather than 405 — same as handleMusic and
  // handleGames. The set of things this can do stays enumerable and a typo
  // becomes an ordinary not-found instead of a hint about what else is here.
  if (!expected || req.method !== expected) {
    return sendJson(res, 404, { error: 'not found' });
  }

  if (subPath === '/devices') return await sendDevices(res);
  return await sendCommand(req, res, subPath);
}
