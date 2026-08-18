// LG webOS (SSAP) — open a URL on the TV.
//
// SSAP is JSON over a WebSocket on port 3000, so this file contains a WebSocket
// client written against RFC 6455 directly on `node:net`. That is not stubbornness
// for its own sake: the alternative is a dependency (`ws`) in a service whose
// only reason to exist is that it may not have any, and the subset a control
// channel needs is small — an HTTP Upgrade handshake, masked client frames, and
// enough of the reader to survive fragmentation and a ping.
//
// Pairing is the part worth understanding. The first connection makes the TV
// show a confirmation dialog and, once someone presses OK, the TV hands back a
// `client-key` that must be presented on every later connection. Lose the key
// and the owner gets prompted again, on their television, every time they cast —
// so it is persisted to CAST_DATA_DIR.

import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logError, logInfo } from '../log.mjs';

const DATA_DIR = process.env.CAST_DATA_DIR || '/data';
const KEY_FILE = join(DATA_DIR, 'ssap-keys.json');
// A client-key is a bearer credential: whoever holds it can open a session to
// the television and drive it without the owner ever seeing a dialog. It is
// stored in a bind-mounted directory on the host, next to whatever else lives
// there, so it gets credential permissions rather than whatever the umask of
// the moment happened to be (0644 on a default umask — world-readable).
const KEY_FILE_MODE = 0o600;

const CONNECT_TIMEOUT_MS = 5_000;
// How long a registration that needs no prompt may take. A TV that already
// trusts us answers in well under a second.
const REGISTER_TIMEOUT_MS = 6_000;
// Once the TV says it is showing the dialog, this is how long the HTTP caller
// waits before being told "accept it on the TV". Anything longer is a request
// hanging on a human being.
const PAIRING_GRACE_MS = 2_500;
// ...but the socket stays open this much longer in the BACKGROUND. If the owner
// presses OK ten seconds later, the key still arrives and still gets stored, so
// the retry they were just told to do succeeds without a second prompt. Closing
// the socket at PAIRING_GRACE_MS would throw away the exact confirmation we
// asked them for.
const PAIRING_LINGER_MS = 90_000;
const REQUEST_TIMEOUT_MS = 8_000;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// webOS's own browser. Used only as the fallback target for /stop when this
// process has not seen the launch that opened it (a restart, a second replica):
// `system.launcher/open` with a URL is what webOS routes to this app id.
const BROWSER_APP_ID = 'com.webos.app.browser';

// The permissions the TV asks the owner to grant. Only what this service uses:
// launching a URL and closing it again. Asking for input, audio or app listing
// would widen a prompt the owner has to read and approve on their television.
const REGISTER_MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.0',
  permissions: ['LAUNCH', 'LAUNCH_WEBAPP', 'CLOSE', 'CONTROL_DISPLAY'],
};

// ---------------------------------------------------------------------------
// RFC 6455 — the pure half, which is what the tests drive.
// ---------------------------------------------------------------------------

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/** The `Sec-WebSocket-Accept` a server must answer a given key with (§4.2.2). */
export function websocketAcceptKey(key) {
  return createHash('sha1')
    .update(`${key}${WS_GUID}`, 'utf8')
    .digest('base64');
}

/**
 * One frame.
 *
 * `mask` defaults to true because a CLIENT frame must be masked — a server is
 * required to close the connection on an unmasked one (§5.1), which presents as
 * a TV that accepts the handshake and then hangs up for no visible reason.
 */
export function encodeFrame(opcode, payload, { mask = true, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const header = [];
  header.push((fin ? 0x80 : 0x00) | (opcode & 0x0f));

  const maskBit = mask ? 0x80 : 0x00;
  if (body.length < 126) {
    header.push(maskBit | body.length);
  } else if (body.length <= 0xffff) {
    header.push(maskBit | 126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    // 64-bit length. Node's Buffer writes it as BigInt; a payload this size is
    // not something SSAP sends, but the reader accepts it so the writer should
    // too rather than emit a frame it could not itself read back.
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(body.length));
    header.push(maskBit | 127, ...len);
  }

  const head = Buffer.from(header);
  if (!mask) return Buffer.concat([head, body]);

  const maskKey = randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ maskKey[i & 3];
  return Buffer.concat([head, maskKey, masked]);
}

/**
 * A frame reader fed arbitrary TCP chunks.
 *
 * TCP gives no message boundaries: a single `data` event can carry half a frame
 * or three of them, and treating one event as one frame is the classic bug that
 * only shows up once a payload crosses the MTU — which for SSAP is the app list,
 * not the tiny messages this service sends. Hence a real buffer.
 */
export function createFrameReader() {
  let buffer = Buffer.alloc(0);

  return {
    /** @returns {{ opcode: number, fin: boolean, payload: Buffer }[]} */
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      const frames = [];

      for (;;) {
        if (buffer.length < 2) break;
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < offset + 2) break;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) break;
          const big = buffer.readBigUInt64BE(offset);
          // A frame this large is a lie or a bug on the other end; either way it
          // must not become an allocation attempt.
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large');
          length = Number(big);
          offset += 8;
        }

        let maskKey = null;
        if (masked) {
          if (buffer.length < offset + 4) break;
          maskKey = buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        if (buffer.length < offset + length) break; // wait for the rest
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
        buffer = buffer.subarray(offset + length);
        frames.push({ opcode, fin, payload });
      }

      return frames;
    },
  };
}

/**
 * Frames -> whole messages, joining continuations.
 *
 * Control frames (ping/close) are passed through untouched: they may arrive in
 * the MIDDLE of a fragmented message and must not be mistaken for part of it.
 */
export function createMessageReader() {
  const reader = createFrameReader();
  let opcode = null;
  let parts = [];

  return {
    push(chunk) {
      const out = [];
      for (const frame of reader.push(chunk)) {
        if (frame.opcode >= 0x8) {
          out.push({ control: frame.opcode, payload: frame.payload });
          continue;
        }
        if (frame.opcode !== OPCODE.continuation) {
          opcode = frame.opcode;
          parts = [];
        } else if (opcode === null) {
          // A continuation with no message to continue. Emitting it anyway
          // produced a message with a null opcode, which the session then tried
          // to `JSON.parse` as if it were text — noise in the logs caused by
          // the peer's protocol error, dressed up as our own parse failure.
          out.push({ control: OPCODE.close, payload: Buffer.alloc(0), protocolError: true });
          continue;
        }
        parts.push(frame.payload);
        if (!frame.fin) continue;
        out.push({ opcode, payload: Buffer.concat(parts) });
        parts = [];
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// client-key persistence
// ---------------------------------------------------------------------------

/**
 * All stored keys, by address.
 *
 * An unreadable store is not fatal — the TV will just prompt again — but it IS
 * logged: "the owner gets a dialog on the television every single time" is a
 * defect that otherwise looks like normal behaviour forever.
 */
async function readKeys() {
  try {
    return JSON.parse(await readFile(KEY_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') logError('ssap.keys.read', err, { file: KEY_FILE });
    return {};
  }
}

async function storeKey(address, key) {
  try {
    await mkdir(dirname(KEY_FILE), { recursive: true });
    const keys = await readKeys();
    if (keys[address] === key) return;
    keys[address] = key;
    // Write-then-rename: a half-written JSON file would make every future
    // connection prompt, and the failure would be indistinguishable from the TV
    // having forgotten us.
    const tmp = `${KEY_FILE}.tmp`;
    await writeFile(tmp, `${JSON.stringify(keys, null, 2)}\n`, {
      encoding: 'utf8',
      mode: KEY_FILE_MODE,
    });
    // `mode` on writeFile is masked by the process umask AND ignored outright
    // when the temp file already exists from an earlier run, so it is a request,
    // not a guarantee. chmod is the guarantee. Do it BEFORE the rename so the
    // key file is never briefly readable under its final name.
    await chmod(tmp, KEY_FILE_MODE);
    await rename(tmp, KEY_FILE);
    logInfo('ssap.keys', 'client-key stored', { address });
  } catch (err) {
    logError('ssap.keys.write', err, { file: KEY_FILE, address });
  }
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/** Resolves once the server has answered 101 and proven it read our key. */
function openSocket(address, port) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = createConnection({ host: address, port });
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    let handshake = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onClose = () => fail(new Error('ssap connection closed during handshake'));
    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error('ssap handshake timed out')));
    socket.on('close', onClose);

    socket.on('connect', () => {
      socket.write(
        [
          'GET / HTTP/1.1',
          `Host: ${address}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });

    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) {
        // A handshake this long is not a handshake.
        if (handshake.length > 8 * 1024) fail(new Error('ssap handshake too large'));
        return;
      }

      const head = handshake.subarray(0, end).toString('utf8');
      const rest = handshake.subarray(end + 4);
      if (!/^HTTP\/1\.1\s+101\b/i.test(head)) {
        fail(new Error(`ssap upgrade refused: ${head.split('\r\n')[0]}`));
        return;
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      // Checking it is not ceremony: it is the only evidence that what answered
      // is a WebSocket server and not some other service that happens to sit on
      // port 3000 and say 101.
      if (accept !== websocketAcceptKey(key)) {
        fail(new Error('ssap upgrade accept-key mismatch'));
        return;
      }

      settled = true;
      socket.removeListener('data', onData);
      // By name, not by a fresh arrow: `removeListener` compares by identity, so
      // a re-created closure removes nothing and the handshake's "connection
      // closed" error fires on every ordinary teardown afterwards.
      socket.removeListener('close', onClose);
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      resolve({ socket, leftover: rest });
    };

    socket.on('data', onData);
  });
}

/**
 * A live SSAP session: JSON in, JSON out, with the WebSocket in between.
 *
 * `onJson` gets every decoded message. Pings are answered here because a TV that
 * stops getting pongs closes the socket mid-launch.
 */
function attach(socket, leftover) {
  const messages = createMessageReader();
  const listeners = new Set();
  let closed = false;

  const handle = (chunk) => {
    let decoded;
    try {
      decoded = messages.push(chunk);
    } catch (err) {
      logError('ssap.frame', err, {});
      session.close();
      return;
    }
    for (const message of decoded) {
      if (message.control === OPCODE.ping) {
        socket.write(encodeFrame(OPCODE.pong, message.payload));
        continue;
      }
      if (message.control === OPCODE.close) {
        session.close();
        continue;
      }
      if (message.control) continue; // a pong; nothing to do
      let json;
      try {
        json = JSON.parse(message.payload.toString('utf8'));
      } catch (err) {
        logError('ssap.json', err, {});
        continue;
      }
      for (const listener of [...listeners]) listener(json);
    }
  };

  const session = {
    send(payload) {
      if (closed) return;
      socket.write(encodeFrame(OPCODE.text, JSON.stringify(payload)));
    },
    onJson(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      socket.on('close', listener);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        socket.write(encodeFrame(OPCODE.close, Buffer.alloc(0)));
      } catch {
        // The socket is already gone; ending it below is all that is left.
      }
      // `end`, not `destroy`: destroying throws away the close frame that was
      // just queued, and a TV that never sees one keeps the session slot until
      // its own timeout. The unref'd timer is the backstop for a TV that never
      // answers the FIN — it can never hold the process open by itself.
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref();
    },
  };

  socket.on('data', handle);
  socket.on('error', (err) => {
    logError('ssap.socket', err, {});
    session.close();
  });
  if (leftover?.length) handle(leftover);
  return session;
}

let requestSeq = 0;
function nextId(prefix) {
  requestSeq += 1;
  return `${prefix}_${requestSeq}`;
}

/** Addresses currently waiting for a human to press OK on the television. */
const pendingPairings = new Set();
/** What `system.launcher/open` last returned per address, so /stop can close it. */
const lastLaunch = new Map();

/**
 * Connect and register.
 *
 * @returns {Promise<{ session, needsPairing: false } | { session: null, needsPairing: true }>}
 */
async function register(address, port) {
  const keys = await readKeys();
  const storedKey = keys[address];
  const { socket, leftover } = await openSocket(address, port);
  const session = attach(socket, leftover);

  return await new Promise((resolve) => {
    let settled = false;
    const id = nextId('register');
    let promptSeen = false;
    let graceTimer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(graceTimer);
      resolve(value);
    };

    const timeout = setTimeout(() => {
      session.close();
      finish({ session: null, needsPairing: false, error: 'registration timed out' });
    }, REGISTER_TIMEOUT_MS);

    const off = session.onJson((message) => {
      if (message.id !== id) return;

      if (message.type === 'registered') {
        const key = message.payload?.['client-key'];
        off();
        // AWAITED, not fire-and-forget. The whole point of the key is that the
        // NEXT cast finds it on disk, and a `play` that answers before the
        // write lands makes "cast twice quickly" prompt a second time on the
        // television for no reason a log would ever explain. `storeKey` never
        // rejects (it logs and returns), so this costs a few milliseconds and
        // buys "when play returns, the key is stored".
        const done = () => finish({ session, needsPairing: false });
        if (key && key !== storedKey) void storeKey(address, key).then(done, done);
        else done();
        return;
      }

      if (message.type === 'response' && message.payload?.pairingType) {
        // The dialog is up on the television. Give whoever is in the room a
        // couple of seconds, then answer the HTTP caller instead of holding the
        // request open on a human — but leave the socket listening (see below).
        promptSeen = true;
        graceTimer = setTimeout(() => {
          clearTimeout(timeout);
          lingerForPairing(address, session, off);
          finish({ session: null, needsPairing: true });
        }, PAIRING_GRACE_MS);
        return;
      }

      if (message.type === 'error') {
        off();
        session.close();
        finish({
          session: null,
          needsPairing: promptSeen,
          error: String(message.error || 'registration refused'),
        });
      }
    });

    session.onClose(() => {
      if (settled) return;
      finish({ session: null, needsPairing: promptSeen, error: 'connection closed' });
    });

    session.send({
      type: 'register',
      id,
      payload: {
        forcePairing: false,
        pairingType: 'PROMPT',
        ...(storedKey ? { 'client-key': storedKey } : {}),
        manifest: REGISTER_MANIFEST,
      },
    });
  });
}

/**
 * Keep listening after the caller has been told to accept on the TV.
 *
 * Without this, pressing OK ten seconds later would produce a key that arrives
 * on a socket nobody is reading and is then thrown away — so the retry prompts
 * again, and so does the one after that.
 */
function lingerForPairing(address, session, offRegister) {
  if (pendingPairings.has(address)) {
    session.close();
    return;
  }
  pendingPairings.add(address);
  offRegister();

  const done = () => {
    pendingPairings.delete(address);
    clearTimeout(timer);
    session.close();
  };
  // `unref`: a minute and a half of waiting for a human must not be the reason
  // this process refuses to shut down. Docker's SIGTERM should end it now, not
  // after the dialog on the television times out.
  const timer = setTimeout(() => {
    logInfo('ssap.pairing', 'pairing not confirmed in time', { address });
    done();
  }, PAIRING_LINGER_MS).unref();

  session.onJson((message) => {
    const key = message?.payload?.['client-key'];
    if (message?.type === 'registered' && key) {
      void storeKey(address, key);
      logInfo('ssap.pairing', 'pairing confirmed on the television', { address });
      done();
    }
  });
  session.onClose(done);
}

/** One `ssap://…` request, resolved with the TV's own payload. */
function request(session, uri, payload) {
  return new Promise((resolve) => {
    const id = nextId('req');
    const timeout = setTimeout(() => {
      off();
      resolve({ ok: false, error: `${uri} timed out` });
    }, REQUEST_TIMEOUT_MS);

    const off = session.onJson((message) => {
      if (message.id !== id) return;
      clearTimeout(timeout);
      off();
      if (message.type === 'error' || message.payload?.returnValue === false) {
        // English: this string is a log field and gets interpolated into the
        // Spanish `reason` by the caller. Only `reason` itself is Spanish.
        resolve({ ok: false, error: String(message.error || 'request refused') });
        return;
      }
      resolve({ ok: true, payload: message.payload || {} });
    });

    session.send({ type: 'request', id, uri, payload });
  });
}

// ---------------------------------------------------------------------------
// The adapter surface used by server.mjs
// ---------------------------------------------------------------------------

export const capability = 'app';

/** @param {{ address: string, endpoint: { port: number } }} device */
export async function play(device, { appUrl }) {
  if (!appUrl) {
    return { ok: false, reason: 'No se recibió la dirección de la app para abrir en la TV.' };
  }

  let registration;
  try {
    registration = await register(device.address, device.endpoint?.port || 3000);
  } catch (err) {
    logError('ssap.connect', err, { address: device.address });
    return {
      ok: false,
      reason: 'No se pudo conectar con la TV. Fijate que esté encendida y en la misma red.',
    };
  }

  if (registration.needsPairing) {
    return {
      ok: false,
      needsPairing: true,
      reason: 'La TV está pidiendo permiso en pantalla. Aceptalo con el control y volvé a darle play.',
    };
  }
  if (!registration.session) {
    logError('ssap.register', registration.error || 'unknown', { address: device.address });
    return { ok: false, reason: 'La TV no aceptó el emparejamiento. Probá apagarla y prenderla de nuevo.' };
  }

  const session = registration.session;
  try {
    const result = await request(session, 'ssap://system.launcher/open', { target: appUrl });
    if (!result.ok) {
      logError('ssap.open', result.error || 'refused', { address: device.address });
      return { ok: false, reason: `La TV no pudo abrir la página (${result.error}).` };
    }
    // Remembered only so /stop has something to close; losing it on a restart
    // costs a fallback, not correctness.
    lastLaunch.set(device.address, {
      id: result.payload.id || BROWSER_APP_ID,
      sessionId: result.payload.sessionId,
    });
    logInfo('ssap.open', 'opened on the television', { address: device.address });
    return { ok: true };
  } finally {
    session.close();
  }
}

export async function stop(device) {
  let registration;
  try {
    registration = await register(device.address, device.endpoint?.port || 3000);
  } catch (err) {
    logError('ssap.connect', err, { address: device.address });
    return { ok: false, reason: 'No se pudo conectar con la TV para cerrar la app.' };
  }
  if (!registration.session) {
    return {
      ok: false,
      ...(registration.needsPairing ? { needsPairing: true } : {}),
      reason: 'La TV no aceptó la conexión, así que no se pudo cerrar nada.',
    };
  }

  const session = registration.session;
  try {
    // The remembered launch when there is one; otherwise webOS's browser, which
    // is what `system.launcher/open` with a URL starts. If that guess is wrong
    // the TV says so and the message reaches the user — it is never silent.
    const launched = lastLaunch.get(device.address) || { id: BROWSER_APP_ID };
    const result = await request(session, 'ssap://system.launcher/close', {
      id: launched.id,
      ...(launched.sessionId ? { sessionId: launched.sessionId } : {}),
    });
    if (!result.ok) {
      logError('ssap.close', result.error || 'refused', { address: device.address });
      return { ok: false, reason: `La TV no pudo cerrar la app (${result.error}).` };
    }
    lastLaunch.delete(device.address);
    return { ok: true };
  } finally {
    session.close();
  }
}
