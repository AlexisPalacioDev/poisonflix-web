// Tests for the hand-written WebSocket half of the SSAP adapter.
//
// This is the part that has no business being wrong: a framing bug does not
// look like a framing bug from the outside, it looks like an LG TV that accepts
// the connection and then ignores every command. Everything below is pure —
// the TV itself is never involved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPCODE,
  createFrameReader,
  createMessageReader,
  encodeFrame,
  websocketAcceptKey,
} from './ssap.mjs';

describe('websocketAcceptKey', () => {
  test('matches the worked example in RFC 6455 §1.3', () => {
    // If this drifts, every handshake is rejected as "accept-key mismatch" and
    // the TV is blamed for it.
    assert.equal(websocketAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('frames', () => {
  function roundTrip(payload) {
    const reader = createFrameReader();
    const frames = reader.push(encodeFrame(OPCODE.text, payload));
    assert.equal(frames.length, 1);
    return frames[0];
  }

  test('a short payload survives the round trip', () => {
    const frame = roundTrip('{"type":"register"}');
    assert.equal(frame.opcode, OPCODE.text);
    assert.equal(frame.fin, true);
    assert.equal(frame.payload.toString('utf8'), '{"type":"register"}');
  });

  test('the 16-bit length path (126) survives it too', () => {
    const payload = 'x'.repeat(200);
    assert.equal(roundTrip(payload).payload.toString('utf8'), payload);
  });

  test('and the 64-bit one (127)', () => {
    // webOS's app list crosses 64 KB, which is where this path starts.
    const payload = 'y'.repeat(70_000);
    assert.equal(roundTrip(payload).payload.length, 70_000);
  });

  test('client frames are masked, with a key that changes', () => {
    const payload = Buffer.from('aaaaaaaa', 'utf8');
    const first = encodeFrame(OPCODE.text, payload);
    const second = encodeFrame(OPCODE.text, payload);
    // Bit 0x80 of the second byte is the mask flag. A server MUST close the
    // connection on an unmasked client frame (§5.1), which presents as a TV
    // that hangs up for no visible reason.
    assert.equal(first[1] & 0x80, 0x80);
    assert.notDeepEqual(first.subarray(2), second.subarray(2), 'the mask key is not constant');
    assert.equal(createFrameReader().push(first)[0].payload.toString('utf8'), 'aaaaaaaa');
  });

  test('a frame split across TCP chunks is reassembled', () => {
    // The bug this pins: one `data` event is not one frame. Feeding a byte at a
    // time is the worst case and the cheapest way to prove the buffer works.
    const encoded = encodeFrame(OPCODE.text, 'z'.repeat(500));
    const reader = createFrameReader();
    let frames = [];
    for (const byte of encoded) frames = frames.concat(reader.push(Buffer.from([byte])));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.length, 500);
  });

  test('several frames arriving in one chunk are all read', () => {
    const chunk = Buffer.concat([
      encodeFrame(OPCODE.text, 'one'),
      encodeFrame(OPCODE.text, 'two'),
      encodeFrame(OPCODE.ping, Buffer.alloc(0)),
    ]);
    const frames = createFrameReader().push(chunk);
    assert.deepEqual(
      frames.map((f) => [f.opcode, f.payload.toString('utf8')]),
      [
        [OPCODE.text, 'one'],
        [OPCODE.text, 'two'],
        [OPCODE.ping, ''],
      ],
    );
  });

  test('an unmasked server frame is read as well', () => {
    // The TV never masks; only clients do.
    const frame = createFrameReader().push(encodeFrame(OPCODE.text, 'hola', { mask: false }))[0];
    assert.equal(frame.payload.toString('utf8'), 'hola');
  });
});

describe('messages', () => {
  test('continuation frames are joined back into one message', () => {
    const chunk = Buffer.concat([
      encodeFrame(OPCODE.text, '{"type":"reg', { fin: false }),
      encodeFrame(OPCODE.continuation, 'istered"}', { fin: true }),
    ]);
    const messages = createMessageReader().push(chunk);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.toString('utf8'), '{"type":"registered"}');
  });

  test('a continuation with nothing to continue fails the connection', () => {
    // The peer broke the protocol. Emitting the fragment as a message gave it a
    // null opcode, which the session then tried to JSON.parse — logging OUR
    // parse failure for THEIR error. Closing is what RFC 6455 §5.4 asks for.
    const messages = createMessageReader().push(
      encodeFrame(OPCODE.continuation, 'orphan', { fin: true }),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].control, OPCODE.close);
    assert.equal(messages[0].protocolError, true);
  });

  test('a ping in the middle of a fragmented message stays separate', () => {
    // Control frames may interleave with fragments (§5.4). Appending one to the
    // payload would corrupt the JSON that was being assembled.
    const chunk = Buffer.concat([
      encodeFrame(OPCODE.text, 'part-one ', { fin: false }),
      encodeFrame(OPCODE.ping, 'beat'),
      encodeFrame(OPCODE.continuation, 'part-two', { fin: true }),
    ]);
    const messages = createMessageReader().push(chunk);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].control, OPCODE.ping);
    assert.equal(messages[1].payload.toString('utf8'), 'part-one part-two');
  });
});
