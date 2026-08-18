// Tests for the HTTP surface, driven over a real socket against the real
// handler — the same reason games.test.mjs does it that way: a hand-rolled fake
// `res` is the one place a status code can be wrong without a test noticing.
//
//   node --test "infra/cast-bridge/**/*.test.mjs"
//
// The scan budgets are cut to milliseconds BEFORE importing the module (it
// reads them at import time, like the BFF's GAMES_DIR). That is what keeps this
// file fast, and it is also why the assertions never claim anything about WHICH
// devices are found: this runs on a real LAN and the answer depends on what is
// plugged in. What it does pin is the shape of every answer and the behaviour
// that must not depend on hardware — an unknown id is a 404, a missing id is a
// 400, and nothing ever leaks the internal endpoint.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let baseUrl;
let server;

before(async () => {
  process.env.CAST_SCAN_TIMEOUT_MS = '50';
  process.env.CAST_DESCRIPTOR_TIMEOUT_MS = '200';
  process.env.CAST_CACHE_TTL_MS = '30000';
  const { handleRequest } = await import('./server.mjs');

  server = createServer((req, res) => void handleRequest(req, res));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /healthz', () => {
  test('answers ok without touching the network', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('GET /devices', () => {
  test('always answers 200 with a list, whatever the LAN says', async () => {
    // The contract is explicit: no casting available must never break the
    // player screen, so this route has no failure status.
    const res = await fetch(`${baseUrl}/devices`);
    assert.equal(res.status, 200);
    const { devices } = await res.json();
    assert.ok(Array.isArray(devices));
  });

  test('every entry has the contract shape and nothing internal', async () => {
    const { devices } = await (await fetch(`${baseUrl}/devices`)).json();
    for (const device of devices) {
      assert.equal(typeof device.id, 'string');
      assert.equal(typeof device.name, 'string');
      assert.match(device.address, /^\d+\.\d+\.\d+\.\d+$/);
      assert.ok(['ssap', 'dial', 'dlna', 'cast'].includes(device.protocol));
      assert.ok(['app', 'media', 'none'].includes(device.capability));
      assert.equal(device.id, `${device.protocol}:${device.address}`);
      // The rule this service exists for: unusable is listed WITH the reason.
      if (device.capability === 'none') assert.equal(typeof device.reason, 'string');
      assert.equal(device.endpoint, undefined);
    }
  });

  test('rejects anything but GET', async () => {
    assert.equal((await post('/devices', {})).status, 404);
  });
});

describe('POST /play', () => {
  test('a device that is not on the network is a 404 with a reason', async () => {
    const res = await post('/play', {
      // An address that can never come back from a scan, so the outcome does
      // not depend on what is switched on in the living room.
      deviceId: 'dial:203.0.113.255',
      appUrl: 'https://poisonflix.example/watch/7',
      mediaUrl: 'https://poisonflix.example/stream/7.mp4',
      title: 'Alien',
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unknown_device');
    assert.match(body.reason, /escanear/);
  });

  test('a request with no device is a 400', async () => {
    const res = await post('/play', { appUrl: 'https://x/' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_request');
  });

  test('unparseable JSON is a 400, not a 500', async () => {
    const res = await post('/play', '{not json');
    assert.equal(res.status, 400);
  });

  test('an oversized body is refused with 413', async () => {
    const res = await post('/play', {
      deviceId: 'dial:203.0.113.255',
      title: 'x'.repeat(100_000),
    });
    assert.equal(res.status, 413);
  });

  test('rejects anything but POST', async () => {
    assert.equal((await fetch(`${baseUrl}/play`)).status, 404);
  });
});

describe('POST /stop', () => {
  test('an unknown device is a 404 here too', async () => {
    const res = await post('/stop', { deviceId: 'cast:203.0.113.254' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'unknown_device');
  });
});

describe('unknown routes', () => {
  test('are 404 and say nothing else', async () => {
    const res = await fetch(`${baseUrl}/../etc/passwd`);
    assert.equal(res.status, 404);
  });
});
