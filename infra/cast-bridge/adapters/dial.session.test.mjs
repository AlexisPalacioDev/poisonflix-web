// DIAL play/stop against a fake television.
//
// The parser tests next door prove we can read what a TV says; these prove we
// say the right thing back. No hardware: a fake DIAL receiver is a `node:http`
// server that answers four routes, and it can be made to misbehave on demand —
// which is the half a real TV in the living room will not do on request.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { play, stop } from './dial.mjs';

let server;
let device;
/** Flipped by the tests to make the fake TV answer differently. */
let state = 'running';
let launches = [];
let deletes = [];

const RUNNING = `<?xml version="1.0"?>
<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">
  <name>PoisonFlix</name><options allowStop="true"/>
  <state>running</state><link rel="run" href="run"/>
</service>`;

const STOPPED = `<?xml version="1.0"?>
<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">
  <name>PoisonFlix</name><options allowStop="true"/><state>stopped</state>
</service>`;

before(async () => {
  server = createServer(async (req, res) => {
    const { method, url } = req;
    if (url === '/ws/app/PoisonFlix' && method === 'GET') {
      if (state === 'missing') {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(state === 'running' ? RUNNING : STOPPED);
    }
    if (url === '/ws/app/PoisonFlix' && method === 'POST') {
      if (state === 'missing') {
        res.writeHead(404);
        return res.end();
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      launches.push({
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: req.headers['content-type'],
      });
      state = 'running';
      res.writeHead(201, { location: `http://127.0.0.1:${server.address().port}/ws/app/PoisonFlix/run` });
      return res.end();
    }
    if (url === '/ws/app/PoisonFlix/run' && method === 'DELETE') {
      deletes.push(url);
      state = 'stopped';
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  device = {
    address: '127.0.0.1',
    // Trailing slash on purpose: it is what the Samsung on this LAN publishes.
    endpoint: { applicationUrl: `http://127.0.0.1:${server.address().port}/ws/app/`, app: 'PoisonFlix' },
  };
});

after(async () => {
  await new Promise((done) => server.close(done));
});

describe('dial.play', () => {
  test('launches the app and hands it the page URL', async () => {
    state = 'stopped';
    launches = [];
    const result = await play(device, { appUrl: 'https://poisonflix.example/watch/7', title: 'Alien' });
    assert.deepEqual(result, { ok: true });
    assert.equal(launches.length, 1);
    // DIAL §6.1: the payload is opaque text. Several firmwares reject
    // `application/x-www-form-urlencoded` even when the body is exactly that.
    assert.match(launches[0].contentType, /^text\/plain/);
    const params = new URLSearchParams(launches[0].body);
    assert.equal(params.get('url'), 'https://poisonflix.example/watch/7');
    assert.equal(params.get('title'), 'Alien');
  });

  test('a TV that no longer has the app says so in Spanish', async () => {
    state = 'missing';
    const result = await play(device, { appUrl: 'https://poisonflix.example/watch/7' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /instalala desde su tienda/i);
  });

  test('a TV that does not answer is a reason, not a crash', async () => {
    const dead = {
      address: '127.0.0.1',
      // Port 1 is reserved and nothing listens on it: a connection refused,
      // which is what a TV that is switched off looks like.
      endpoint: { applicationUrl: 'http://127.0.0.1:1/ws/app/', app: 'PoisonFlix' },
    };
    const result = await play(dead, { appUrl: 'https://x/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no respondió/);
  });

  test('no appUrl is refused before any request is made', async () => {
    launches = [];
    const result = await play(device, { appUrl: null, mediaUrl: 'https://x/v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(launches.length, 0);
  });
});

describe('dial.stop', () => {
  test('deletes the running instance', async () => {
    state = 'running';
    deletes = [];
    assert.deepEqual(await stop(device), { ok: true });
    assert.deepEqual(deletes, ['/ws/app/PoisonFlix/run']);
  });

  test('a stop that stopped nothing does NOT report ok', async () => {
    // The failure this prevents: a UI showing "listo" while the video plays on.
    state = 'stopped';
    const result = await stop(device);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no está corriendo/);
  });
});
