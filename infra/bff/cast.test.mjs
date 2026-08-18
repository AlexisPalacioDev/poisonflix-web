// Tests for the cast proxy. Node's built-in runner, because this service has
// zero runtime dependencies and adding one to test it would be a strange thing
// to do to it.
//
//   node --test infra/bff/cast.test.mjs
//
// Everything goes over real HTTP in both directions: a real server in front of
// the real handler, and a real (or deliberately dead) stub bridge behind it.
// The cases that matter here are failure cases — an unreachable bridge, a
// bridge answering rubbish — and a hand-rolled fake `res` or a stubbed `fetch`
// would be the one place a status code could be wrong without a test noticing.
// That is exactly the defect class this file exists to prevent, so it is not a
// place to accept a double.
//
// cast.mjs reads CAST_BRIDGE_URL at import time (games.mjs and jam.mjs do the
// same with their own env). To exercise several configurations in one run, each
// one imports the module under a different query suffix — `./cast.mjs?x=1` is a
// distinct specifier to the ESM loader, so it gets its own module instance with
// its own frozen constant. It is the same file either way.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

/** Every request the stub bridge saw, so forwarding can be asserted on. */
let received = [];
let bridge; // the stub cast-bridge
let bridgeUrl;

/** What the stub answers next. Swapped per test. */
let bridgeReply = { status: 200, body: JSON.stringify({ devices: [] }), type: 'application/json' };

/**
 * Misbehaviour the stub can be told to perform:
 *   'normal'   answer bridgeReply
 *   'redirect' 3xx pointing at `pivot` — the SSRF probe
 *   'stall'    send headers promising a body, then kill the socket
 */
let bridgeMode = 'normal';

/** Stands in for an internal service an SSRF would pivot to. */
let pivot;
let pivotUrl;
let pivotHits = [];

/** baseUrl per configuration: a live bridge, a dead one, and none at all. */
const app = {};

const DEVICES = [
  {
    id: 'ssap:192.168.0.20',
    name: 'LG webOS TV',
    address: '192.168.0.20',
    protocol: 'ssap',
    capability: 'app',
    model: 'OLED55C1',
  },
  {
    id: 'dial:192.168.0.20',
    name: 'LG webOS TV',
    address: '192.168.0.20',
    protocol: 'dial',
    capability: 'none',
    reason: 'Instalá PoisonFlix en esta TV para poder abrirla desde acá.',
  },
];

/**
 * Mount one module instance behind a real server and return its base URL.
 *
 * The catch-all mirrors server.mjs's router deliberately, down to the status
 * code: a handler that REJECTS becomes `500 internal` in production, and
 * without the same net here a rejection would instead leave the request hanging
 * forever. A hanging test reports as a timeout minutes later, or not at all —
 * so the one thing these tests exist to catch would be the one thing they could
 * not show. Measured: with the body read moved outside its try, this suite hung
 * instead of failing until this was added.
 */
async function mount(mod) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://bff');
    Promise.resolve(mod.handleCast(req, res, url.pathname.slice('/bff/cast'.length))).catch(
      (err) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'internal', rejected: String(err) }));
      },
    );
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

before(async () => {
  // The service an SSRF would land on. In production the equivalents are
  // radarr, sonarr, prowlarr, jellyseerr and jellyfin — all reachable from the
  // BFF's networks, all holding the API keys this process exists to hide.
  pivot = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    pivotHits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ secret: 'an internal service answered', devices: [{ id: 'pwned' }] }));
  });
  await new Promise((done) => pivot.listen(0, '127.0.0.1', done));
  pivotUrl = `http://127.0.0.1:${pivot.address().port}`;

  bridge = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'] || null,
      body: Buffer.concat(chunks).toString('utf8'),
    });

    if (bridgeMode === 'redirect') {
      // 307 preserves the method AND the body across the hop, which is what
      // makes this a write primitive rather than a read one.
      res.writeHead(307, { location: `${pivotUrl}/internal/secret` });
      return res.end();
    }

    if (bridgeMode === 'stall') {
      // Headers promising a body that never arrives, then the socket dies —
      // the shape of a bridge that crashes mid-answer.
      //
      // The delay before destroying is the entire point and was NOT here at
      // first. Destroying immediately makes undici reject inside `fetch()`,
      // which the existing catch already covers, so the test went green against
      // the defective code and proved nothing. Letting the headers land first
      // makes `fetch()` RESOLVE and pushes the failure into `arrayBuffer()`,
      // which is the line that was outside the try. Measured both ways.
      res.writeHead(bridgeReply.status, {
        'content-type': bridgeReply.type,
        'content-length': '4096',
      });
      res.write('{"ok"');
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }

    res.writeHead(bridgeReply.status, { 'content-type': bridgeReply.type });
    res.end(bridgeReply.body);
  });
  await new Promise((done) => bridge.listen(0, '127.0.0.1', done));
  bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;

  // A port nothing is listening on. Binding one and closing it immediately is
  // how the port is known to be free, so the connection is refused rather than
  // answered by whatever else happens to be running on this machine.
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const deadUrl = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((done) => probe.close(done));

  process.env.CAST_BRIDGE_URL = bridgeUrl;
  app.up = await mount(await import('./cast.mjs?config=up'));

  process.env.CAST_BRIDGE_URL = deadUrl;
  app.down = await mount(await import('./cast.mjs?config=down'));

  delete process.env.CAST_BRIDGE_URL;
  app.unset = await mount(await import('./cast.mjs?config=unset'));

  // Left unset so a later import cannot silently pick up a stale value.
});

after(async () => {
  for (const key of Object.keys(app)) {
    await new Promise((done) => app[key].server.close(done));
  }
  await new Promise((done) => bridge.close(done));
  await new Promise((done) => pivot.close(done));
});

function expectBridge(status, body, type = 'application/json') {
  bridgeReply = { status, body: typeof body === 'string' ? body : JSON.stringify(body), type };
  bridgeMode = 'normal';
  received = [];
  pivotHits = [];
}

describe('GET /bff/cast/devices — the happy path', () => {
  test('forwards to the bridge and returns its devices verbatim', async () => {
    expectBridge(200, { devices: DEVICES });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: DEVICES });

    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'GET');
    assert.equal(received[0].url, '/devices');
  });

  test('an unusable device is passed through with its reason, not filtered out', async () => {
    // The contract is explicit that a device nobody can cast to is LISTED with
    // the reason why. A proxy that quietly dropped `capability: 'none'` would
    // turn "install the app on that TV" into a TV that simply is not there.
    expectBridge(200, { devices: DEVICES });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);
    const { devices } = await res.json();
    const unusable = devices.find((d) => d.capability === 'none');
    assert.ok(unusable, 'the unusable device was dropped by the proxy');
    assert.match(unusable.reason, /PoisonFlix/);
  });
});

describe('GET /bff/cast/devices — degradation must never be a 5xx', () => {
  // The whole reason this route exists in this shape. The player screen asks
  // for the device list while a film is playing; a 500 there would break
  // watching a movie because nobody was casting it. Every failure below is an
  // empty shelf with a 200, which is also what a working bridge answers on a
  // LAN with no TVs.

  test('a bridge that is not running answers { devices: [] }, not a 502', async () => {
    const res = await fetch(`${app.down.baseUrl}/bff/cast/devices`);
    assert.equal(res.status, 200, 'an unreachable cast-bridge must not surface as an error');
    assert.deepEqual(await res.json(), { devices: [] });
  });

  test('CAST_BRIDGE_URL unset answers { devices: [] } without dialling anything', async () => {
    expectBridge(200, { devices: DEVICES });

    const res = await fetch(`${app.unset.baseUrl}/bff/cast/devices`);
    assert.equal(res.status, 200, 'a deploy without casting must not surface as an error');
    assert.deepEqual(await res.json(), { devices: [] });
    assert.equal(received.length, 0, 'nothing should be dialled when no bridge is configured');
  });

  test('a bridge answering 500 answers { devices: [] }', async () => {
    expectBridge(500, { error: 'scan failed' });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: [] });
  });

  test('a bridge answering non-JSON answers { devices: [] }', async () => {
    expectBridge(200, '<html>proxy error</html>', 'text/html');

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: [] });
  });

  test('a bridge answering the wrong shape answers { devices: [] }', async () => {
    // Not pedantry: the SPA validates with Zod and would reject a bad payload
    // as an ERROR state on the player screen. This route's contract is that
    // casting can be absent, never broken.
    for (const shape of [{}, { devices: null }, { devices: { 0: 'a' } }, 'null', '[]']) {
      expectBridge(200, shape);
      const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);
      assert.equal(res.status, 200, `unexpected status for ${JSON.stringify(shape)}`);
      assert.deepEqual(await res.json(), { devices: [] });
    }
  });
});

describe('POST /bff/cast/play', () => {
  test('forwards the body and content-type, and returns the bridge answer verbatim', async () => {
    expectBridge(200, { ok: true });
    const payload = {
      deviceId: 'ssap:192.168.0.20',
      appUrl: 'https://poisonflix.example.ts.net/watch/abc',
      mediaUrl: 'https://poisonflix.example.ts.net/stream/abc.mp4',
      title: 'Dune',
    };

    const res = await fetch(`${app.up.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/play');
    assert.equal(received[0].contentType, 'application/json');
    // Both URLs survive the hop: the adapter on the other side picks one by the
    // device's capability, so a proxy that dropped either would break a whole
    // class of device and leave the other working.
    assert.deepEqual(JSON.parse(received[0].body), payload);
  });

  test('needsPairing reaches the client as a 200, not an error', async () => {
    // The TV is showing a confirmation dialog and a retry will work. Anything
    // that normalised this into a failure would turn a two-second prompt into a
    // dead button.
    expectBridge(200, { ok: false, needsPairing: true });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'ssap:192.168.0.20' }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, needsPairing: true });
  });

  test("the bridge's own error status is preserved rather than flattened", async () => {
    expectBridge(409, { ok: false, error: 'device_busy' });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x' }),
    });

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, error: 'device_busy' });
  });

  test('an over-sized body is refused before it is buffered', async () => {
    expectBridge(200, { ok: true });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(200 * 1024),
    });

    assert.equal(res.status, 413);
    assert.equal(received.length, 0, 'an over-sized body must not reach the bridge');
  });

  test('the over-size path pauses the upload instead of destroying it', async () => {
    // A source assertion, because the defect it guards is a RACE and the test
    // above cannot see it: leaving a `for await (const chunk of req)` loop early
    // makes Node destroy the request, so the socket can die before the 413
    // flushes and the caller gets a bare `100` that Caddy reports as a 502. Over
    // loopback the response usually wins that race, so the wrong version passes
    // the assertion above every time. server.mjs carries the same scar in its
    // own readBody, in the same shape, for the same reason.
    const source = await readFile(new URL('./cast.mjs', import.meta.url), 'utf8');
    const body = source.match(/function readBody\(req\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(body, 'readBody not found — re-check this test');
    assert.ok(!/for await/.test(body), 'readBody destroys the request on the over-size path');
    assert.ok(body.includes('req.pause()'), 'readBody must pause the upload, not destroy it');
  });
});

describe('POST /bff/cast/stop', () => {
  test('forwards to the bridge', async () => {
    expectBridge(200, { ok: true });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dlna:192.168.0.31' }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(received[0].url, '/stop');
    assert.deepEqual(JSON.parse(received[0].body), { deviceId: 'dlna:192.168.0.31' });
  });
});

describe('commands fail loudly, unlike the device list', () => {
  // The deliberate asymmetry. Someone pressed a button and expects a picture on
  // a television: answering 200 when the bridge never heard about it leaves
  // them watching a TV that is never going to change, with nothing on screen to
  // say why.

  test('an unreachable bridge answers 502, not a fake success', async () => {
    for (const path of ['/bff/cast/play', '/bff/cast/stop']) {
      const res = await fetch(`${app.down.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'x' }),
      });
      assert.equal(res.status, 502, `${path} hid an unreachable bridge`);
      assert.deepEqual(await res.json(), { error: 'cast_bridge_unreachable' });
    }
  });

  test('no bridge configured answers 503, not a fake success', async () => {
    const res = await fetch(`${app.unset.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x' }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'cast_bridge_unconfigured' });
  });
});

describe('routing', () => {
  test('only the three contracted routes exist, and only with their own verb', async () => {
    expectBridge(200, { devices: [] });

    for (const [path, method] of [
      // /healthz is for `docker compose`, not for a browser. Proxying it would
      // publish a liveness oracle for a service on the owner's LAN.
      ['/bff/cast/healthz', 'GET'],
      ['/bff/cast/', 'GET'],
      ['/bff/cast/devices/x', 'GET'],
      ['/bff/cast/pair', 'POST'],
      // Right route, wrong verb.
      ['/bff/cast/devices', 'POST'],
      ['/bff/cast/play', 'GET'],
      ['/bff/cast/stop', 'DELETE'],
    ]) {
      const res = await fetch(`${app.up.baseUrl}${path}`, { method });
      assert.equal(res.status, 404, `unexpected route accepted: ${method} ${path}`);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
    assert.equal(received.length, 0, 'a rejected route must not reach the bridge');
  });

  test('a query string is not forwarded to the bridge', async () => {
    // The handler takes no `search` argument on purpose: none of the three
    // routes uses one, and forwarding an unvalidated one widens what a browser
    // can hand to a service that talks to the owner's television.
    expectBridge(200, { devices: [] });

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices?rescan=1&host=evil`);
    assert.equal(res.status, 200);
    assert.equal(received[0].url, '/devices');
  });
});

describe('the bridge is not allowed to redirect this service anywhere', () => {
  // The allowlist above is only true if a 3xx cannot move the request off it.
  // With fetch's default (`follow`), a single redirect from whatever answers on
  // port 8791 re-POSTs the body to an arbitrary URL and hands the answer back
  // to the browser — an SSRF into radarr/sonarr/prowlarr/jellyseerr/jellyfin
  // with the caller's payload attached. And 8791 is a HOST port under host
  // networking, so "whatever answers" is not necessarily the bridge.

  test('a redirect on /play does not become a request to another service', async () => {
    expectBridge(200, { ok: true });
    bridgeMode = 'redirect';

    const res = await fetch(`${app.up.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x', appUrl: 'https://example.test/watch' }),
    });

    assert.deepEqual(pivotHits, [], 'the redirect was followed: this is an SSRF with a body');
    assert.equal(res.status, 502, 'a redirecting bridge must be a failed hop, not a pivot');
    assert.deepEqual(await res.json(), { error: 'cast_bridge_unreachable' });
  });

  test('a redirect on /devices does not leak another service into the shelf', async () => {
    expectBridge(200, { devices: [] });
    bridgeMode = 'redirect';

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);

    assert.deepEqual(pivotHits, [], 'the redirect was followed on the read path');
    // Still the degradation contract: not an error, just an empty shelf.
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: [] });
  });
});

describe('a bridge that dies halfway through its answer', () => {
  // The failure lives in `arrayBuffer()`, not in `fetch()`: the headers arrived,
  // so the request "succeeded" and only reading the body rejects. With that read
  // outside the try, the rejection escaped to the router's catch-all and the
  // caller got `500 internal` under scope 'router' — contradicting the 502 this
  // module documents. A stub that always finishes its response cannot see it,
  // which is why this one destroys its socket mid-body.

  test('/play answers 502, not the router 500', async () => {
    expectBridge(200, { ok: true });
    bridgeMode = 'stall';

    const res = await fetch(`${app.up.baseUrl}/bff/cast/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x' }),
    });

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'cast_bridge_unreachable' });
  });

  test('/devices still answers an empty shelf', async () => {
    expectBridge(200, { devices: [] });
    bridgeMode = 'stall';

    const res = await fetch(`${app.up.baseUrl}/bff/cast/devices`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: [] });
  });

  test('handleCast never rejects, whatever the bridge does', async () => {
    // Directly, because the two cases above only prove the STATUS. An escaping
    // rejection is also an unhandledRejection in production, and the router's
    // catch-all is the last thing that should be deciding this module's answers.
    const mod = await import('./cast.mjs?config=up');
    for (const mode of ['redirect', 'stall']) {
      for (const [path, method] of [
        ['/devices', 'GET'],
        ['/play', 'POST'],
        ['/stop', 'POST'],
      ]) {
        expectBridge(200, { devices: [] });
        bridgeMode = mode;
        const sink = createServer((req, res) => {
          mod.handleCast(req, res, path).catch((err) => {
            res.writeHead(599, { 'content-type': 'text/plain' });
            res.end(`handleCast rejected: ${err}`);
          });
        });
        await new Promise((done) => sink.listen(0, '127.0.0.1', done));
        const url = `http://127.0.0.1:${sink.address().port}${path}`;
        const res = await fetch(url, {
          method,
          ...(method === 'POST'
            ? { headers: { 'content-type': 'application/json' }, body: '{"deviceId":"x"}' }
            : {}),
        }).catch(() => null);
        await new Promise((done) => sink.close(done));
        assert.notEqual(res, null, `${method} ${path} in ${mode} mode killed the connection`);
        assert.notEqual(
          res.status,
          599,
          `handleCast rejected for ${method} ${path} in ${mode} mode: ${await res.text()}`,
        );
      }
    }
  });
});

describe('the session gate in server.mjs', () => {
  // This suite mounts handleCast bare, with no auth in front of it — which is
  // exactly what the real router does NOT do. Nothing else here would notice if
  // someone moved the /bff/cast dispatch above the 401, and the bridge holds no
  // auth of its own: anyone who can reach the proxy could then enumerate the
  // owner's LAN devices and put whatever they liked on the television. Booting
  // server.mjs to test it for real is not an option (it listens at import and
  // calls Jellyseerr), so assert on the two lines that decide it.
  test('the dispatch sits below the resolveUser 401, not above it', async () => {
    const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');

    const gate = source.indexOf("if (!user) return send(res, 401, { error: 'unauthenticated' })");
    const dispatch = source.indexOf("path.startsWith('/bff/cast/')");

    assert.notEqual(gate, -1, 'the 401 gate moved or was reworded — re-check this test');
    assert.notEqual(dispatch, -1, 'the /bff/cast dispatch moved or was reworded');
    assert.ok(
      gate < dispatch,
      'the /bff/cast dispatch is ABOVE the authentication gate: anyone who can reach the proxy could drive the LAN television',
    );
  });

  test('the dispatch sits below the CSRF Origin check', async () => {
    // /play and /stop are cookie-authenticated mutations, so without this a
    // page on any other origin could start playback on the owner's TV.
    const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');

    const csrf = source.indexOf("return send(res, 403, { error: 'bad_origin' })");
    const dispatch = source.indexOf("path.startsWith('/bff/cast/')");

    assert.notEqual(csrf, -1, 'the Origin check moved or was reworded — re-check this test');
    assert.ok(csrf < dispatch, 'the /bff/cast dispatch is ABOVE the CSRF Origin check');
  });

  test('cast is not reachable through the *arr passthrough prefixes', async () => {
    const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
    const backends = source.match(/const BACKENDS = \{[\s\S]*?\n\};/)?.[0] ?? '';
    assert.ok(backends.includes('radarr'), 'BACKENDS block not found — re-check this test');
    assert.ok(!backends.includes('cast'), 'cast must never be an *arr-style passthrough backend');
  });
});

describe('the bridge address is configuration, not a constant', () => {
  test('no docker gateway IP is hard-coded in the handler', async () => {
    // The gateway address differs per host AND per network: measured
    // 172.21.0.1 for media-automation on the dev laptop and 172.19.0.1 for the
    // same network on the deploy server. A default baked in here would be
    // wrong on one of them and would fail as an empty device list — the one
    // symptom this module makes indistinguishable from "no TVs". It belongs in
    // compose/.env, where it is visible next to the network it describes.
    const source = await readFile(new URL('./cast.mjs', import.meta.url), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    const literals = code.match(/\b172\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
    assert.deepEqual(literals, [], 'a docker gateway IP is hard-coded in cast.mjs');
  });
});
