// Tests for the hand-written CASTV2 protobuf.
//
// A protobuf written by hand is exactly the kind of code that "works" against
// the one message you tried it with and then loses a field on the next
// firmware. These tests drive the encoder and the decoder against each other,
// and — the case that actually matters — a message carrying fields this
// decoder has never heard of.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCastFrameReader,
  decodeCastMessage,
  encodeCastMessage,
  frameCastMessage,
} from './cast.mjs';

const LAUNCH = {
  sourceId: 'sender-poisonflix',
  destinationId: 'receiver-0',
  namespace: 'urn:x-cast:com.google.cast.receiver',
  payload: { type: 'LAUNCH', requestId: 1, appId: 'CC1AD845' },
};

describe('CastMessage', () => {
  test('survives the round trip with the payload intact', () => {
    const decoded = decodeCastMessage(encodeCastMessage(LAUNCH));
    assert.equal(decoded.sourceId, LAUNCH.sourceId);
    assert.equal(decoded.destinationId, LAUNCH.destinationId);
    assert.equal(decoded.namespace, LAUNCH.namespace);
    assert.equal(decoded.protocolVersion, 0);
    assert.equal(decoded.payloadType, 0);
    assert.deepEqual(JSON.parse(decoded.payloadUtf8), LAUNCH.payload);
  });

  test('titles keep their accents and their emoji', () => {
    // The title travels inside the LOAD payload and ends up on the television.
    // Length prefixes count BYTES, not characters; getting that wrong truncates
    // exactly the titles this house watches.
    const title = 'El día que la Tierra se detuvo 🎬';
    const decoded = decodeCastMessage(
      encodeCastMessage({ ...LAUNCH, payload: { type: 'LOAD', title } }),
    );
    assert.equal(JSON.parse(decoded.payloadUtf8).title, title);
  });

  test('unknown fields are skipped instead of throwing', () => {
    // A receiver that starts sending a new field must not break every cast.
    const body = Buffer.concat([
      encodeCastMessage(LAUNCH),
      Buffer.from([(9 << 3) | 0, 0x2a]), // field 9, varint
      Buffer.from([(10 << 3) | 2, 0x03, 0x61, 0x62, 0x63]), // field 10, "abc"
      Buffer.from([(11 << 3) | 5, 0, 0, 0, 0]), // field 11, fixed32
    ]);
    const decoded = decodeCastMessage(body);
    assert.equal(decoded.namespace, LAUNCH.namespace);
    assert.deepEqual(JSON.parse(decoded.payloadUtf8), LAUNCH.payload);
  });

  test('a truncated message is an error, not half a message', () => {
    const body = encodeCastMessage(LAUNCH);
    assert.throws(() => decodeCastMessage(body.subarray(0, body.length - 5)));
  });
});

describe('framing', () => {
  test('the length prefix is four big-endian bytes', () => {
    const body = encodeCastMessage(LAUNCH);
    const framed = frameCastMessage(body);
    assert.equal(framed.readUInt32BE(0), body.length);
    assert.equal(framed.length, body.length + 4);
  });

  test('two messages in one TCP chunk are both read', () => {
    const chunk = Buffer.concat([
      frameCastMessage(encodeCastMessage(LAUNCH)),
      frameCastMessage(
        encodeCastMessage({
          ...LAUNCH,
          namespace: 'urn:x-cast:com.google.cast.tp.heartbeat',
          payload: { type: 'PING' },
        }),
      ),
    ]);
    const messages = createCastFrameReader().push(chunk);
    assert.equal(messages.length, 2);
    assert.equal(JSON.parse(messages[1].payloadUtf8).type, 'PING');
  });

  test('a message split across chunks is held until it is whole', () => {
    const framed = frameCastMessage(encodeCastMessage(LAUNCH));
    const reader = createCastFrameReader();
    // Split inside the length prefix itself: the reader must not treat two
    // bytes of a 4-byte header as a length.
    assert.deepEqual(reader.push(framed.subarray(0, 2)), []);
    assert.deepEqual(reader.push(framed.subarray(2, 9)), []);
    const messages = reader.push(framed.subarray(9));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].destinationId, 'receiver-0');
  });

  test('an absurd declared length is refused instead of allocated', () => {
    const chunk = Buffer.alloc(8);
    chunk.writeUInt32BE(0xfffffff, 0);
    assert.throws(() => createCastFrameReader().push(chunk), /too large/);
  });
});
