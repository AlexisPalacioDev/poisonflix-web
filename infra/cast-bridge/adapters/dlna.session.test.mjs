// DLNA play/stop against a fake renderer.
//
// What matters here is the ORDER and the recovery: `SetAVTransportURI` before
// `Play`, and a renderer that accepts the URI then refuses to start must not be
// reported the same way as one that rejected the video outright — the first
// leaves the film loaded on the device, which is worth telling someone.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { play, stop } from './dlna.mjs';

let server;
let device;
let calls = [];
/** Action name -> fault to answer with, set per test. */
let faults = {};

const FAULT_718 = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>
<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>718</errorCode><errorDescription>Transition not available</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const action = /#(\w+)"?$/.exec(req.headers['soapaction'] || '')?.[1] || null;
    calls.push({ action, body, soapAction: req.headers['soapaction'] });

    if (faults[action]) {
      res.writeHead(500, { 'content-type': 'text/xml' });
      return res.end(faults[action]);
    }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>` +
        `</s:Body></s:Envelope>`,
    );
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  device = {
    address: '127.0.0.1',
    endpoint: { controlUrl: `http://127.0.0.1:${server.address().port}/upnp/control/AVTransport1` },
  };
});

after(async () => {
  await new Promise((done) => server.close(done));
});

describe('dlna.play', () => {
  test('loads the URI, then plays, in that order', async () => {
    // A renderer told to Play before it has a URI answers 718 and shows
    // nothing, which is the most common way this protocol looks broken.
    calls = [];
    faults = {};
    assert.deepEqual(await play(device, { mediaUrl: 'http://bff/v.mkv?t=1&x=2', title: 'Alien & Aliens' }), {
      ok: true,
    });
    assert.deepEqual(
      calls.map((c) => c.action),
      ['SetAVTransportURI', 'Play'],
    );
    // The SOAPAction quotes are required by the spec; without them renderers
    // answer 401/412 with no explanation.
    assert.equal(calls[0].soapAction, '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"');
    // The URL's `&` survived as an entity rather than closing the element early.
    assert.match(calls[0].body, /<CurrentURI>http:\/\/bff\/v\.mkv\?t=1&amp;x=2<\/CurrentURI>/);
    // The DIDL travels double-escaped, and carries the right container type.
    assert.match(calls[0].body, /&lt;DIDL-Lite/);
    assert.match(calls[0].body, /video\/x-matroska/);
    assert.match(calls[0].body, /Alien &amp;amp; Aliens/);
  });

  test('a rejected URI reports the UPnP error, not just a failure', async () => {
    calls = [];
    faults = { SetAVTransportURI: FAULT_718 };
    const result = await play(device, { mediaUrl: 'http://bff/v.mp4' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /718/);
    assert.match(result.reason, /Transition not available/);
    // It never went on to Play something the device refused to load.
    assert.deepEqual(
      calls.map((c) => c.action),
      ['SetAVTransportURI'],
    );
  });

  test('a URI that loaded but would not start says exactly that', async () => {
    faults = { Play: FAULT_718 };
    const result = await play(device, { mediaUrl: 'http://bff/v.mp4' });
    assert.equal(result.ok, false);
    // The distinction is the point: the film IS on the device and its own
    // remote can start it.
    assert.match(result.reason, /llegó al dispositivo pero no arrancó/);
  });

  test('a renderer that is switched off is a reason, not a crash', async () => {
    const dead = { address: '127.0.0.1', endpoint: { controlUrl: 'http://127.0.0.1:1/ctl' } };
    const result = await play(dead, { mediaUrl: 'http://bff/v.mp4' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no respondió/);
  });
});

describe('dlna.stop', () => {
  test('sends Stop on the same control URL', async () => {
    calls = [];
    faults = {};
    assert.deepEqual(await stop(device), { ok: true });
    assert.deepEqual(
      calls.map((c) => c.action),
      ['Stop'],
    );
  });

  test('a refused Stop is not reported as ok', async () => {
    faults = { Stop: FAULT_718 };
    const result = await stop(device);
    assert.equal(result.ok, false);
    assert.match(result.reason, /718/);
  });
});
