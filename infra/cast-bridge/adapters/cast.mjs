// Chromecast (CASTV2) — TLS on port 8009, protobuf frames, JSON inside.
//
// The protobuf here is written by hand, and it is smaller than it sounds: the
// whole protocol is ONE message type, with six fields, five of which are strings.
//
//   message CastMessage {
//     required ProtocolVersion protocol_version = 1;  // CASTV2_1_0 = 0
//     required string source_id      = 2;
//     required string destination_id = 3;
//     required string namespace      = 4;
//     required PayloadType payload_type = 5;          // STRING = 0, BINARY = 1
//     optional string payload_utf8    = 6;
//     optional bytes  payload_binary  = 7;
//   }
//
// Each message goes on the wire behind a 4-byte big-endian length. Everything
// interesting is the JSON in `payload_utf8`, split across namespaces that behave
// like channels: `connection` (open/close a virtual link), `heartbeat` (the
// device hangs up on a sender that stops answering PINGs), `receiver` (launch
// and stop applications) and `media` (load and control what is playing).
//
// `rejectUnauthorized: false` is not laziness: every Chromecast presents a
// certificate signed by Google's own device CA for a hostname that is its serial
// number, so no public root validates it and nothing on this LAN resolves that
// name. The link is still encrypted; what it is not is authenticated, which is
// the same trust level as the SSDP announcement that found the device.

import { connect as tlsConnect } from 'node:tls';

import { logError, logInfo } from '../log.mjs';
import { guessMimeType, isAdaptive } from '../mime.mjs';

const DEFAULT_PORT = 8009;
// The Default Media Receiver: Google's own player app, present on every device
// and — the reason it is used here — usable without registering an App ID.
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

const SOURCE_ID = 'sender-poisonflix';
const RECEIVER_ID = 'receiver-0';

const CONNECT_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 10_000;
// The device closes an idle connection after roughly 10 seconds without a
// heartbeat, which lands mid-LOAD on a slow launch.
const HEARTBEAT_MS = 4_000;
// A frame larger than this is not a status message. Nothing legitimate here
// comes close: the fattest RECEIVER_STATUS is a few kilobytes.
const MAX_FRAME_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Protobuf — the pure half, which the tests drive end to end.
// ---------------------------------------------------------------------------

function encodeVarint(value) {
  const bytes = [];
  let rest = BigInt(value);
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return { value: Number(result), next: pos };
}

function field(number, wireType) {
  return encodeVarint((number << 3) | wireType);
}

function lengthDelimited(number, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([field(number, 2), encodeVarint(body.length), body]);
}

/** A `CastMessage` with a UTF-8 JSON payload, without its length prefix. */
export function encodeCastMessage({
  sourceId,
  destinationId,
  namespace,
  payload,
  protocolVersion = 0,
  payloadType = 0,
}) {
  return Buffer.concat([
    field(1, 0),
    encodeVarint(protocolVersion),
    lengthDelimited(2, sourceId),
    lengthDelimited(3, destinationId),
    lengthDelimited(4, namespace),
    field(5, 0),
    encodeVarint(payloadType),
    lengthDelimited(6, typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ]);
}

/**
 * The inverse.
 *
 * Unknown fields are SKIPPED rather than rejected: protobuf's whole contract is
 * that a newer sender may add fields, and a decoder that throws on one turns a
 * firmware update into a feature that stops working.
 */
export function decodeCastMessage(buf) {
  const message = {
    protocolVersion: 0,
    sourceId: '',
    destinationId: '',
    namespace: '',
    payloadType: 0,
    payloadUtf8: null,
    payloadBinary: null,
  };

  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const number = tag.value >> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 0) {
      const varint = readVarint(buf, pos);
      pos = varint.next;
      if (number === 1) message.protocolVersion = varint.value;
      else if (number === 5) message.payloadType = varint.value;
      continue;
    }
    if (wireType === 2) {
      const len = readVarint(buf, pos);
      const start = len.next;
      const end = start + len.value;
      if (end > buf.length) throw new Error('truncated length-delimited field');
      const slice = buf.subarray(start, end);
      pos = end;
      if (number === 2) message.sourceId = slice.toString('utf8');
      else if (number === 3) message.destinationId = slice.toString('utf8');
      else if (number === 4) message.namespace = slice.toString('utf8');
      else if (number === 6) message.payloadUtf8 = slice.toString('utf8');
      else if (number === 7) message.payloadBinary = Buffer.from(slice);
      continue;
    }
    // Fixed-width fields this message never uses, skipped by their known size.
    if (wireType === 5) {
      pos += 4;
      continue;
    }
    if (wireType === 1) {
      pos += 8;
      continue;
    }
    // Groups (3/4) were removed from proto3 and nothing here emits them; a
    // stream carrying one is not a CastMessage and continuing would resync on
    // garbage.
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }

  return message;
}

/** Length-prefixed, the way the socket wants it. */
export function frameCastMessage(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Splits a TCP stream back into decoded messages. */
export function createCastFrameReader() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      const messages = [];
      for (;;) {
        if (buffer.length < 4) break;
        const length = buffer.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) throw new Error(`cast frame too large: ${length}`);
        if (buffer.length < 4 + length) break;
        messages.push(decodeCastMessage(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
      }
      return messages;
    },
  };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

function openSession(address, port) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: address,
        port,
        // See the header comment: the certificate is real, signed by a CA no
        // public trust store carries, for a name that does not resolve.
        rejectUnauthorized: false,
        timeout: CONNECT_TIMEOUT_MS,
      },
      () => {
        socket.setTimeout(0);
        // CONNECT before anything else, and before the caller gets the session:
        // every other namespace is refused until the virtual connection to
        // `receiver-0` exists, and the refusal is silence.
        session.send(NS_CONNECTION, { type: 'CONNECT' });
        session.send(NS_HEARTBEAT, { type: 'PING' });
        heartbeat = setInterval(() => session.send(NS_HEARTBEAT, { type: 'PING' }), HEARTBEAT_MS);
        resolved = true;
        resolve(session);
      },
    );

    const reader = createCastFrameReader();
    const listeners = new Set();
    let closed = false;
    let resolved = false;
    let heartbeat = null;

    const session = {
      send(namespace, payload, destinationId = RECEIVER_ID) {
        if (closed) return;
        socket.write(
          frameCastMessage(
            encodeCastMessage({
              sourceId: SOURCE_ID,
              destinationId,
              namespace,
              payload,
            }),
          ),
        );
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(listener) {
        socket.on('close', listener);
      },
      close() {
        if (closed) return;
        try {
          // Politeness with a purpose: a receiver that never sees CLOSE keeps
          // the virtual connection until its own timeout, and a device only
          // accepts so many. Sent BEFORE `closed` is set, because `send` is a
          // no-op once it is — flipping the flag first would have made this
          // line look like it worked while sending nothing at all.
          session.send(NS_CONNECTION, { type: 'CLOSE' });
        } catch {
          // Already gone.
        }
        closed = true;
        clearInterval(heartbeat);
        // `end`, not `destroy`: destroying discards whatever is still in the
        // write buffer, which is the CLOSE that was just queued. The timer is
        // the backstop for a device that never answers the FIN, and it is
        // unref'd so it can never hold the process open by itself.
        socket.end();
        setTimeout(() => socket.destroy(), 1_000).unref();
      },
    };

    socket.on('timeout', () => {
      socket.destroy(new Error('cast connection timed out'));
    });
    socket.on('error', (err) => {
      // Before the session exists the caller gets the error and logs it itself.
      // After that, this listener is the ONLY place a mid-session failure
      // surfaces: without the line, a device that drops the connection halfway
      // through a LOAD shows up as nothing but a timeout with no cause.
      if (resolved) logError('cast.socket', err, { address });
      else reject(err);
      closed = true;
      clearInterval(heartbeat);
      socket.destroy();
    });
    socket.on('data', (chunk) => {
      let messages;
      try {
        messages = reader.push(chunk);
      } catch (err) {
        logError('cast.frame', err, { address });
        session.close();
        return;
      }
      for (const message of messages) {
        let payload = null;
        try {
          payload = message.payloadUtf8 ? JSON.parse(message.payloadUtf8) : null;
        } catch (err) {
          logError('cast.json', err, { namespace: message.namespace });
          continue;
        }
        if (payload?.type === 'PING') {
          session.send(NS_HEARTBEAT, { type: 'PONG' }, message.sourceId || RECEIVER_ID);
          continue;
        }
        for (const listener of [...listeners]) listener(message, payload);
      }
    });
  });
}

let requestSeq = 0;
function nextRequestId() {
  requestSeq += 1;
  return requestSeq;
}

/**
 * Wait for the first message `match` accepts, or time out.
 *
 * The matcher decides what counts, and the two callers below decide it
 * differently on purpose. The receiver broadcasts unsolicited RECEIVER_STATUS
 * whenever anything on the device changes, so LAUNCH looks for the media
 * receiver actually RUNNING rather than for its requestId — if someone else's
 * phone just launched the same app, that is a perfectly good outcome. LOAD does
 * pin its requestId, because a MEDIA_STATUS about someone else's video is not
 * evidence that ours loaded.
 */
function waitFor(session, match, timeoutMs, what) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve({ ok: false, error: `${what} timed out` });
    }, timeoutMs);
    const off = session.on((message, payload) => {
      if (!payload) return;
      const value = match(message, payload);
      if (value === undefined || value === null || value === false) return;
      clearTimeout(timer);
      off();
      resolve({ ok: true, value });
    });
  });
}

function runningApp(payload, appId) {
  return (payload?.status?.applications || []).find((app) => app.appId === appId) || null;
}

export const capability = 'media';

export async function play(device, { mediaUrl, title }) {
  if (!mediaUrl) {
    return { ok: false, reason: 'No se recibió la dirección del video para reproducir.' };
  }

  let session;
  try {
    session = await openSession(device.address, device.endpoint?.port || DEFAULT_PORT);
  } catch (err) {
    logError('cast.connect', err, { address: device.address });
    return {
      ok: false,
      reason: 'No se pudo conectar con el Chromecast. Fijate que esté enchufado y en la misma red.',
    };
  }

  try {
    const launchId = nextRequestId();
    session.send(NS_RECEIVER, { type: 'LAUNCH', requestId: launchId, appId: DEFAULT_MEDIA_RECEIVER });
    const launched = await waitFor(
      session,
      (_message, payload) => {
        if (payload.type === 'LAUNCH_ERROR') return { error: payload.reason || 'LAUNCH_ERROR' };
        if (payload.type !== 'RECEIVER_STATUS') return null;
        return runningApp(payload, DEFAULT_MEDIA_RECEIVER);
      },
      LAUNCH_TIMEOUT_MS,
      'launch',
    );

    if (!launched.ok || launched.value.error) {
      const error = launched.value?.error || launched.error;
      logError('cast.launch', error, { address: device.address });
      return { ok: false, reason: `El Chromecast no pudo abrir el reproductor (${error}).` };
    }

    const { transportId, sessionId } = launched.value;
    // A second virtual connection, to the APP this time. Sending media messages
    // to `receiver-0` gets them silently dropped — the device answers nothing at
    // all, which reads exactly like a network problem.
    session.send(NS_CONNECTION, { type: 'CONNECT' }, transportId);

    const contentType = guessMimeType(mediaUrl);
    // An adaptive playlist is not a file the receiver downloads, and the
    // Default Media Receiver's own scrub behaviour depends on being told which
    // it is. `isAdaptive` exists to name that difference; nothing beyond the
    // contentType is sent about it, because everything else the HLS path
    // accepts is unverified against a real device from here.
    if (isAdaptive(contentType)) {
      logInfo('cast.load', 'adaptive stream', { address: device.address, contentType });
    }

    const loadId = nextRequestId();
    session.send(
      NS_MEDIA,
      {
        type: 'LOAD',
        requestId: loadId,
        sessionId,
        autoplay: true,
        currentTime: 0,
        media: {
          contentId: mediaUrl,
          // BUFFERED means a seekable file, as opposed to LIVE. Getting this
          // wrong takes the scrub bar away on the TV.
          streamType: 'BUFFERED',
          // The same guess DLNA makes about the same URL. This used to be a
          // hardcoded `video/mp4`, which told the receiver that an `.m3u8`
          // playlist was a progressive MP4 — one URL, one question, and two
          // adapters answering it differently.
          contentType,
          metadata: { metadataType: 0, title: title || 'PoisonFlix' },
        },
      },
      transportId,
    );

    const loaded = await waitFor(
      session,
      (_message, payload) => {
        if (payload.requestId !== loadId) return null;
        if (payload.type === 'MEDIA_STATUS') return { ok: true };
        if (payload.type === 'LOAD_FAILED' || payload.type === 'LOAD_CANCELLED') {
          return { error: payload.type };
        }
        if (payload.type === 'INVALID_REQUEST') return { error: payload.reason || 'INVALID_REQUEST' };
        return null;
      },
      LOAD_TIMEOUT_MS,
      'load',
    );

    if (!loaded.ok || loaded.value.error) {
      const error = loaded.value?.error || loaded.error;
      logError('cast.load', error, { address: device.address });
      return {
        ok: false,
        reason: `El Chromecast abrió el reproductor pero no pudo cargar el video (${error}).`,
      };
    }

    logInfo('cast.load', 'playback started', { address: device.address });
    return { ok: true };
  } finally {
    session.close();
  }
}

export async function stop(device) {
  let session;
  try {
    session = await openSession(device.address, device.endpoint?.port || DEFAULT_PORT);
  } catch (err) {
    logError('cast.connect', err, { address: device.address });
    return { ok: false, reason: 'No se pudo conectar con el Chromecast para detener el video.' };
  }

  try {
    const statusId = nextRequestId();
    session.send(NS_RECEIVER, { type: 'GET_STATUS', requestId: statusId });
    const status = await waitFor(
      session,
      (_message, payload) => (payload.type === 'RECEIVER_STATUS' ? payload : null),
      LAUNCH_TIMEOUT_MS,
      'status',
    );
    if (!status.ok) {
      return { ok: false, reason: 'El Chromecast no contestó qué está reproduciendo.' };
    }

    // OUR app, not `applications[0]`. The first entry is whatever the device
    // happens to be running, so stopping it blindly would kill someone else's
    // Netflix session because a phone in this house pressed stop on ours.
    const app = runningApp(status.value, DEFAULT_MEDIA_RECEIVER);
    // Nothing of ours running is not `ok: true`: a stop that stopped nothing
    // must not report success to a UI that will then claim the TV is free.
    if (!app?.sessionId) {
      return { ok: false, reason: 'El Chromecast no está reproduciendo nada de PoisonFlix.' };
    }

    session.send(NS_RECEIVER, { type: 'STOP', requestId: nextRequestId(), sessionId: app.sessionId });
    const stopped = await waitFor(
      session,
      (_message, payload) =>
        payload.type === 'RECEIVER_STATUS' && !runningApp(payload, app.appId) ? true : null,
      LAUNCH_TIMEOUT_MS,
      'stop',
    );
    if (!stopped.ok) {
      logError('cast.stop', stopped.error, { address: device.address });
      return { ok: false, reason: 'El Chromecast no confirmó que haya detenido el video.' };
    }
    return { ok: true };
  } finally {
    session.close();
  }
}
