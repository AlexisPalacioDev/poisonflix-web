// SSAP play/stop against a fake webOS television.
//
// The fake speaks REAL RFC 6455 — it computes the accept key, reads masked
// client frames and answers with unmasked server frames — so the handshake, the
// framing and the SSAP conversation are all exercised for real. What it does
// not have is a screen, which is precisely what lets the pairing prompt be
// tested at all: a real TV needs a human with a remote.
//
// CAST_DATA_DIR is redirected to a temp directory BEFORE importing the adapter,
// because the module reads it at import time (the same trick games.test.mjs
// uses for GAMES_DIR).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deliberately NO static import of ./ssap.mjs: a top-level import runs before
// `before()` can redirect CAST_DATA_DIR, the module captures `/data` at import
// time, and the key ends up written (or refused) somewhere this test never
// looks. That is not hypothetical — it is how the first version of this file
// failed, with `EACCES: permission denied, mkdir '/data'` in the log and a
// `play` that still answered `{ok: true}`.
let ssap; // the module under test, imported after CAST_DATA_DIR is set
let OPCODE;
let createMessageReader;
let encodeFrame;
let dataDir;
let server;
let device;

/** What the fake TV should do when it is asked to register. */
let pairingMode = 'accept';
/** How long it waits before confirming, when it confirms at all. */
let confirmDelayMs = 0;
/** The key it hands out, and the one it will accept back. */
const TV_KEY = 'client-key-from-the-television';
/** Every SSAP request the TV received. */
let received = [];
/** The dialog currently on the fake TV's screen, so a test can accept it. */
let pendingPrompt = null;
/** The key handed out when someone finally accepts a lingering prompt. */
const LATE_KEY = 'client-key-accepted-late';

function send(socket, payload) {
  // Server frames are NOT masked; only client frames are.
  socket.write(encodeFrame(OPCODE.text, JSON.stringify(payload), { mask: false }));
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ssap-test-'));
  process.env.CAST_DATA_DIR = dataDir;
  ssap = await import('./ssap.mjs');
  ({ OPCODE, createMessageReader, encodeFrame } = ssap);

  server = createServer();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    const messages = createMessageReader();
    socket.on('data', (chunk) => {
      for (const message of messages.push(chunk)) {
        if (message.control === OPCODE.ping) {
          socket.write(encodeFrame(OPCODE.pong, message.payload, { mask: false }));
          continue;
        }
        if (message.control) continue;
        const json = JSON.parse(message.payload.toString('utf8'));

        if (json.type === 'register') {
          received.push(json);
          const presented = json.payload?.['client-key'];
          if (pairingMode === 'refuse') {
            send(socket, { type: 'error', id: json.id, error: 'access denied' });
            continue;
          }
          if (presented === TV_KEY) {
            // A known sender: no dialog, straight through.
            send(socket, { type: 'registered', id: json.id, payload: { 'client-key': TV_KEY } });
            continue;
          }
          // An unknown sender: the television puts a dialog on screen and says
          // so, then waits for a human.
          send(socket, { type: 'response', id: json.id, payload: { pairingType: 'PROMPT', returnValue: true } });
          // Remembered so a test can act like the human who eventually walks
          // over and presses OK.
          pendingPrompt = { socket, id: json.id };
          if (pairingMode === 'accept') {
            setTimeout(
              () => send(socket, { type: 'registered', id: json.id, payload: { 'client-key': TV_KEY } }),
              confirmDelayMs,
            ).unref();
          }
          continue;
        }

        if (json.type === 'request') {
          received.push(json);
          if (json.uri === 'ssap://system.launcher/open') {
            send(socket, {
              type: 'response',
              id: json.id,
              payload: { returnValue: true, id: 'com.webos.app.browser', sessionId: 'SESSION-1' },
            });
            continue;
          }
          if (json.uri === 'ssap://system.launcher/close') {
            send(socket, { type: 'response', id: json.id, payload: { returnValue: true } });
            continue;
          }
          send(socket, { type: 'error', id: json.id, error: 'unknown uri' });
        }
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  device = { address: '127.0.0.1', endpoint: { port: server.address().port } };
});

after(async () => {
  await new Promise((done) => server.close(done));
  await rm(dataDir, { recursive: true, force: true });
});

describe('ssap.play', () => {
  test('pairs, opens the URL, and persists the key it was given', async () => {
    pairingMode = 'accept';
    confirmDelayMs = 0;
    received = [];

    const result = await ssap.play(device, { appUrl: 'https://poisonflix.example/watch/7' });
    assert.deepEqual(result, { ok: true });

    const open = received.find((m) => m.uri === 'ssap://system.launcher/open');
    assert.equal(open.payload.target, 'https://poisonflix.example/watch/7');

    // The key on disk is what stops the television from asking again. Without
    // it the owner gets a dialog on their TV on every single cast.
    const stored = JSON.parse(await readFile(join(dataDir, 'ssap-keys.json'), 'utf8'));
    assert.equal(stored['127.0.0.1'], TV_KEY);
  });

  test('the second cast presents the stored key and gets no prompt', async () => {
    received = [];
    const result = await ssap.play(device, { appUrl: 'https://poisonflix.example/watch/8' });
    assert.equal(result.ok, true);
    const register = received.find((m) => m.type === 'register');
    assert.equal(register.payload['client-key'], TV_KEY);
  });

  test('a television that refuses is a reason, never a silent failure', async () => {
    pairingMode = 'refuse';
    const result = await ssap.play(device, { appUrl: 'https://x/' });
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    pairingMode = 'accept';
  });

  test('a television that is off is a reason too', async () => {
    const off = { address: '127.0.0.1', endpoint: { port: 1 } };
    const result = await ssap.play(off, { appUrl: 'https://x/' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Fijate que esté encendida/);
  });
});

describe('ssap pairing', () => {
  test('an unconfirmed prompt answers needsPairing, and a late OK still stores the key', async () => {
    // The behaviour under test is the whole reason the socket outlives the HTTP
    // response: the caller is told to accept on the television, and whenever
    // that finally happens the key is captured — otherwise the retry they were
    // just asked to make prompts them all over again, forever.
    await rm(join(dataDir, 'ssap-keys.json'), { force: true });
    pairingMode = 'never';
    pendingPrompt = null;

    const result = await ssap.play(device, { appUrl: 'https://poisonflix.example/watch/9' });
    assert.equal(result.ok, false);
    assert.equal(result.needsPairing, true);
    assert.match(result.reason, /Aceptalo con el control/);
    assert.ok(pendingPrompt, 'the television is still showing the dialog');

    // Somebody walks over and presses OK, well after the HTTP call was answered.
    send(pendingPrompt.socket, {
      type: 'registered',
      id: pendingPrompt.id,
      payload: { 'client-key': LATE_KEY },
    });

    const deadline = Date.now() + 2_000;
    let stored = null;
    while (Date.now() < deadline) {
      stored = await readFile(join(dataDir, 'ssap-keys.json'), 'utf8').catch(() => null);
      if (stored?.includes(LATE_KEY)) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.match(String(stored), new RegExp(LATE_KEY));
    pairingMode = 'accept';
  });
});

describe('ssap.stop', () => {
  test('closes the session the open returned', async () => {
    received = [];
    assert.deepEqual(await ssap.stop(device), { ok: true });
    const close = received.find((m) => m.uri === 'ssap://system.launcher/close');
    // Both fields come from the launch response, not from a guess.
    assert.equal(close.payload.id, 'com.webos.app.browser');
    assert.equal(close.payload.sessionId, 'SESSION-1');
  });
});

describe('the key file is treated as a credential', () => {
  test('ssap-keys.json is written 0600, not whatever the umask says', async () => {
    // A client-key is a bearer token: whoever holds it opens a session to the
    // television and drives it with no dialog on screen. The file lives in a
    // bind-mounted directory on the host (infra/cast-bridge/data), so under a
    // default umask it would land 0644 — readable by every account on the box
    // and by every container that mounts that path.
    //
    // Written fresh on purpose: `writeFile`'s `mode` is IGNORED when the temp
    // file already exists from an earlier run, which is the case this asserts
    // is handled and the mutation it is meant to catch.
    await rm(join(dataDir, 'ssap-keys.json'), { force: true });
    await rm(join(dataDir, 'ssap-keys.json.tmp'), { force: true });
    pairingMode = 'accept';
    confirmDelayMs = 0;

    const result = await ssap.play(device, { appUrl: 'https://poisonflix.example/watch/10' });
    assert.deepEqual(result, { ok: true });

    const mode = (await stat(join(dataDir, 'ssap-keys.json'))).mode & 0o777;
    assert.equal(
      mode.toString(8).padStart(3, '0'),
      '600',
      'the pairing key must not be world-readable',
    );
  });

  test('an existing loose-permissioned file is tightened, not inherited', async () => {
    // The upgrade path: a store written by the version that had no mode ends up
    // 0644 on disk, and a rename over it would keep that mode forever. This is
    // what proves the chmod happens on the temp file every write, not once at
    // creation.
    const keyFile = join(dataDir, 'ssap-keys.json');
    await chmod(keyFile, 0o644);
    await rm(`${keyFile}.tmp`, { force: true });

    // Force a write by removing the stored key for this address, so storeKey's
    // "already stored, nothing to do" short-circuit does not skip the write.
    const keys = JSON.parse(await readFile(keyFile, 'utf8'));
    delete keys['127.0.0.1'];
    await writeFile(keyFile, `${JSON.stringify(keys)}\n`, 'utf8');
    await chmod(keyFile, 0o644);

    const result = await ssap.play(device, { appUrl: 'https://poisonflix.example/watch/11' });
    assert.deepEqual(result, { ok: true });

    const mode = (await stat(keyFile)).mode & 0o777;
    assert.equal(mode.toString(8).padStart(3, '0'), '600');
  });
});
