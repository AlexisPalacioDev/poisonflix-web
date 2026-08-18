// Tests for discovery: descriptor parsing, capability classification, and the
// DNS wire format. Node's built-in runner, because this service has zero
// runtime dependencies and adding one to test it would be a strange thing to do
// to it.
//
//   node --test "infra/cast-bridge/**/*.test.mjs"
//
// Nothing here touches the network. The fixtures are the two screens on the
// LAN this was written against — a Samsung QN65Q7FAAKXZL that answers DIAL and
// an LG UK6200PDA that announces webOS over SSDP — because the interesting
// decisions are all about what those devices actually said, not about what the
// specs allow.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  appResourceUrl,
  buildDevices,
  buildMdnsQuery,
  chromecastsFromDns,
  classifyDial,
  decodeXmlEntities,
  parseDescriptor,
  parseDnsMessage,
  parseSsdpResponse,
  resolveUrl,
  toPublicDevice,
} from './discovery.mjs';

// The Samsung's real descriptor shape. `&quot;` in the friendlyName is not a
// hypothetical: the set is a 65" QLED and that is how it says so.
const SAMSUNG_DESCRIPTOR = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:dial-multiscreen-org:device:dialreceiver:1</deviceType>
    <friendlyName>65&quot; QLED</friendlyName>
    <manufacturer>Samsung Electronics</manufacturer>
    <modelName>QN65Q7FAAKXZL</modelName>
    <UDN>uuid:0a1b2c3d-4e5f-6789-abcd-ef0123456789</UDN>
    <serviceList>
      <service>
        <serviceType>urn:dial-multiscreen-org:service:dial:1</serviceType>
        <serviceId>urn:dial-multiscreen-org:serviceId:dial</serviceId>
        <controlURL>/dial/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

const RENDERER_DESCRIPTOR = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room Renderer</friendlyName>
    <manufacturer>Acme &amp; Co</manufacturer>
    <modelName>AR-100</modelName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/upnp/control/rendering</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/upnp/control/AVTransport1</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

// A router's IGD descriptor: SSDP's `ssdp:all` finds it on every LAN and it is
// not a screen.
const ROUTER_DESCRIPTOR = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>Router</friendlyName>
    <modelName>RT-N12</modelName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
        <controlURL>/ctl/L3F</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

describe('XML entities', () => {
  test('unescapes the friendlyName the Samsung really sends', () => {
    assert.equal(decodeXmlEntities('65&quot; QLED'), '65" QLED');
  });

  test('handles numeric and hex references', () => {
    assert.equal(decodeXmlEntities('Tele de Ana&#39;s&#x20;casa'), "Tele de Ana's casa");
  });

  test('does not decode twice', () => {
    // `&amp;lt;` is a literal `&lt;`, not a `<`. A naive chain of replaces that
    // expands `&amp;` first turns this into a tag.
    assert.equal(decodeXmlEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
  });
});

describe('parseDescriptor', () => {
  test('reads name, model and services out of the Samsung descriptor', () => {
    const descriptor = parseDescriptor(SAMSUNG_DESCRIPTOR);
    assert.equal(descriptor.friendlyName, '65" QLED');
    assert.equal(descriptor.modelName, 'QN65Q7FAAKXZL');
    assert.equal(descriptor.manufacturer, 'Samsung Electronics');
    assert.match(descriptor.deviceType, /dialreceiver/);
    assert.equal(descriptor.services.length, 1);
  });

  test('finds AVTransport and its control URL on a renderer', () => {
    const descriptor = parseDescriptor(RENDERER_DESCRIPTOR);
    const av = descriptor.services.find((s) => s.serviceType.endsWith('AVTransport:1'));
    assert.equal(av.controlURL, '/upnp/control/AVTransport1');
    assert.equal(descriptor.manufacturer, 'Acme & Co');
  });

  test('missing fields are null, not undefined or empty strings', () => {
    const descriptor = parseDescriptor('<root><device></device></root>');
    assert.equal(descriptor.friendlyName, null);
    assert.deepEqual(descriptor.services, []);
  });
});

describe('parseSsdpResponse', () => {
  const response = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'LOCATION: http://192.168.1.6:1393/description.xml',
    'SERVER: Linux/i686 UPnP/1.0 WebOS/4.1.0 UPnP/1.0',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    'USN: uuid:xyz::urn:schemas-upnp-org:device:MediaRenderer:1',
    '',
    '',
  ].join('\r\n');

  test('lowercases header names and keeps values verbatim', () => {
    const parsed = parseSsdpResponse(response);
    assert.equal(parsed.headers.location, 'http://192.168.1.6:1393/description.xml');
    assert.match(parsed.headers.server, /WebOS\/4\.1\.0/);
  });

  test('refuses anything that is not a 200 answer', () => {
    assert.equal(parseSsdpResponse('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\n\r\n'), null);
    assert.equal(parseSsdpResponse('garbage'), null);
  });
});

describe('DIAL app resource URLs', () => {
  test('respects a trailing slash instead of eating the last segment', () => {
    // The Samsung's Application-URL ends in a slash; `new URL()` would drop
    // `/app/` from the one that does not.
    assert.equal(
      appResourceUrl('http://192.168.1.28:8080/ws/app/', 'PoisonFlix'),
      'http://192.168.1.28:8080/ws/app/PoisonFlix',
    );
    assert.equal(
      appResourceUrl('http://192.168.1.28:8080/ws/app', 'PoisonFlix'),
      'http://192.168.1.28:8080/ws/app/PoisonFlix',
    );
  });
});

describe('classifyDial', () => {
  test('200 means the app is installed', () => {
    assert.deepEqual(classifyDial({ status: 200 }), { capability: 'app' });
  });

  test('404 lists the TV as unusable and says how to fix it', () => {
    const verdict = classifyDial({ status: 404 });
    assert.equal(verdict.capability, 'none');
    assert.match(verdict.reason, /no tiene la app PoisonFlix instalada/);
  });

  test('no answer at all is a reason, not a disappearance', () => {
    const verdict = classifyDial({ status: null });
    assert.equal(verdict.capability, 'none');
    assert.match(verdict.reason, /no respondió/);
  });

  test('an unexpected status says which one it was', () => {
    assert.match(classifyDial({ status: 503 }).reason, /503/);
  });
});

describe('buildDevices', () => {
  const samsung = {
    address: '192.168.1.28',
    location: 'http://192.168.1.28:7678/nservice/',
    server: 'Linux/9.0 UPnP/1.0 Samsung UPnP SDK/1.0',
    searchTargets: ['urn:dial-multiscreen-org:device:dialreceiver:1'],
    applicationUrl: 'http://192.168.1.28:8080/ws/app/',
    descriptor: parseDescriptor(SAMSUNG_DESCRIPTOR),
    descriptorError: null,
  };

  test('a TV without our app is listed, unusable, with the reason', () => {
    const devices = buildDevices({ endpoints: [{ ...samsung, dialProbe: { status: 404 } }] });
    assert.equal(devices.length, 1);
    const [device] = devices;
    assert.equal(device.id, 'dial:192.168.1.28');
    assert.equal(device.name, '65" QLED');
    assert.equal(device.model, 'QN65Q7FAAKXZL');
    assert.equal(device.protocol, 'dial');
    assert.equal(device.capability, 'none');
    assert.match(device.reason, /instalala/i);
  });

  test('the same TV with the app installed becomes an app target', () => {
    const devices = buildDevices({ endpoints: [{ ...samsung, dialProbe: { status: 200 } }] });
    assert.equal(devices[0].capability, 'app');
    assert.equal(devices[0].reason, undefined);
    assert.equal(devices[0].endpoint.applicationUrl, 'http://192.168.1.28:8080/ws/app/');
  });

  test('a DIAL receiver with no AVTransport is never listed as dlna', () => {
    // The Samsung has no AVTransport service — inventing one would produce a
    // device that accepts a video URL and does nothing with it.
    const devices = buildDevices({ endpoints: [{ ...samsung, dialProbe: { status: 200 } }] });
    assert.deepEqual(
      devices.map((d) => d.protocol),
      ['dial'],
    );
  });

  test('an AVTransport service becomes a media target with an absolute control URL', () => {
    const devices = buildDevices({
      endpoints: [
        {
          address: '192.168.1.9',
          location: 'http://192.168.1.9:8200/rootDesc.xml',
          server: 'Linux UPnP/1.0',
          searchTargets: ['urn:schemas-upnp-org:service:AVTransport:1'],
          applicationUrl: null,
          descriptor: parseDescriptor(RENDERER_DESCRIPTOR),
          descriptorError: null,
          dialProbe: null,
        },
      ],
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].protocol, 'dlna');
    assert.equal(devices[0].capability, 'media');
    assert.equal(devices[0].endpoint.controlUrl, 'http://192.168.1.9:8200/upnp/control/AVTransport1');
  });

  test('an AVTransport announcement with no readable descriptor is not listed as dlna', () => {
    // The contract is explicit: without a descriptor that DECLARES the service,
    // it is not a dlna device. It leaves a log line instead of an entry nobody
    // could have played to — see the `discovery.dlna` line in buildDevices.
    const devices = buildDevices({
      endpoints: [
        {
          address: '192.168.1.9',
          location: 'http://192.168.1.9:8200/rootDesc.xml',
          server: null,
          searchTargets: ['urn:schemas-upnp-org:service:AVTransport:1'],
          applicationUrl: null,
          descriptor: null,
          descriptorError: 'HTTP 500',
          dialProbe: null,
        },
      ],
    });
    assert.deepEqual(devices, []);
  });

  test('a webOS TV is offered over SSAP, and only because of the SERVER token', () => {
    const lg = {
      address: '192.168.1.6',
      location: 'http://192.168.1.6:1393/description.xml',
      // Verbatim from the LG UK6200PDA on this LAN.
      server: 'Linux/i686 UPnP/1.0 WebOS/4.1.0 UPnP/1.0',
      searchTargets: ['upnp:rootdevice'],
      applicationUrl: null,
      // Its exact service list is NOT verified (the set was off during the
      // survey), so the fixture claims nothing about AVTransport.
      descriptor: { friendlyName: '[LG] webOS TV UK6200PDA', modelName: 'UK6200PDA', manufacturer: 'LG Electronics', deviceType: 'urn:schemas-upnp-org:device:Basic:1', services: [] },
      descriptorError: null,
      dialProbe: null,
    };
    const devices = buildDevices({ endpoints: [lg] });
    assert.deepEqual(
      devices.map((d) => [d.protocol, d.capability]),
      [['ssap', 'app']],
    );
    assert.equal(devices[0].id, 'ssap:192.168.1.6');
  });

  test('an LG that is not webOS is not offered SSAP', () => {
    // Pre-webOS LG sets (NetCast) say LG just as loudly and do not speak SSAP on
    // port 3000. Trusting the manufacturer instead of the `WebOS` token would
    // list a TV that accepts being selected and then does nothing.
    const netcast = {
      address: '192.168.1.7',
      location: 'http://192.168.1.7:1900/desc.xml',
      server: 'Linux/2.6 UPnP/1.0 LGE NetCast TV',
      searchTargets: ['upnp:rootdevice'],
      applicationUrl: null,
      descriptor: {
        friendlyName: '[LG] NetCast TV',
        modelName: 'LM6200',
        manufacturer: 'LG Electronics',
        deviceType: 'urn:schemas-upnp-org:device:Basic:1',
        services: [],
      },
      descriptorError: null,
      dialProbe: null,
    };
    assert.deepEqual(buildDevices({ endpoints: [netcast] }), []);
  });

  test('a router is not a screen and is not listed at all', () => {
    const devices = buildDevices({
      endpoints: [
        {
          address: '192.168.1.1',
          location: 'http://192.168.1.1:1900/igd.xml',
          server: 'Linux UPnP/1.0',
          searchTargets: ['upnp:rootdevice'],
          applicationUrl: null,
          descriptor: parseDescriptor(ROUTER_DESCRIPTOR),
          descriptorError: null,
          dialProbe: null,
        },
      ],
    });
    assert.deepEqual(devices, []);
  });

  test('one usable entry beats a duplicate unusable one for the same id', () => {
    const base = {
      address: '192.168.1.9',
      server: null,
      applicationUrl: null,
      dialProbe: null,
      descriptorError: null,
    };
    // A webOS set publishes several descriptors and only one of them carries a
    // usable control URL. Which one arrives first is a coin flip, and the list
    // must not depend on it.
    const devices = buildDevices({
      endpoints: [
        {
          ...base,
          location: 'http://192.168.1.9:8200/partial.xml',
          searchTargets: ['urn:schemas-upnp-org:service:AVTransport:1'],
          descriptor: {
            friendlyName: 'Living Room Renderer',
            modelName: 'AR-100',
            manufacturer: 'Acme',
            deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
            services: [{ serviceType: 'urn:schemas-upnp-org:service:AVTransport:1', controlURL: null }],
          },
        },
        {
          ...base,
          location: 'http://192.168.1.9:8200/rootDesc.xml',
          searchTargets: ['urn:schemas-upnp-org:service:AVTransport:1'],
          descriptor: parseDescriptor(RENDERER_DESCRIPTOR),
        },
      ],
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].capability, 'media');
    assert.equal(devices[0].endpoint.controlUrl, 'http://192.168.1.9:8200/upnp/control/AVTransport1');
  });

  test('a chromecast is a media target', () => {
    const devices = buildDevices({
      chromecasts: [
        { name: 'Tele del living', model: 'Chromecast Ultra', address: '192.168.1.44', port: 8009 },
      ],
    });
    assert.deepEqual(toPublicDevice(devices[0]), {
      id: 'cast:192.168.1.44',
      name: 'Tele del living',
      address: '192.168.1.44',
      protocol: 'cast',
      capability: 'media',
      model: 'Chromecast Ultra',
    });
  });

  test('the wire shape never carries the internal endpoint', () => {
    const [device] = buildDevices({ endpoints: [{ ...samsung, dialProbe: { status: 200 } }] });
    assert.ok(device.endpoint, 'the internal record keeps it');
    assert.equal(toPublicDevice(device).endpoint, undefined);
  });
});

describe('resolveUrl', () => {
  test('resolves relative control URLs against the descriptor location', () => {
    assert.equal(
      resolveUrl('http://192.168.1.9:8200/rootDesc.xml', '/ctl/AVT'),
      'http://192.168.1.9:8200/ctl/AVT',
    );
  });

  test('an absolute control URL is left alone', () => {
    assert.equal(
      resolveUrl('http://192.168.1.9:8200/rootDesc.xml', 'http://192.168.1.9:9000/ctl'),
      'http://192.168.1.9:9000/ctl',
    );
  });

  test('nothing in, null out', () => {
    assert.equal(resolveUrl('http://x/', null), null);
  });
});

// ---------------------------------------------------------------------------
// mDNS
// ---------------------------------------------------------------------------

function encodeName(name) {
  const parts = [];
  for (const label of name.split('.')) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, 'utf8'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function record(name, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2); // IN
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([Buffer.isBuffer(name) ? name : encodeName(name), head, data]);
}

function txt(entries) {
  return Buffer.concat(
    entries.map((entry) => Buffer.concat([Buffer.from([entry.length]), Buffer.from(entry, 'utf8')])),
  );
}

function srv(port, target) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

describe('mDNS query', () => {
  test('asks for the googlecast PTR with the unicast-response bit set', () => {
    const query = buildMdnsQuery('_googlecast._tcp.local', { id: 0x1234 });
    const parsed = parseDnsMessage(query);
    assert.equal(parsed.id, 0x1234);
    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.questions[0].name, '_googlecast._tcp.local');
    assert.equal(parsed.questions[0].type, 12); // PTR
    // 0x8000 is QU: "answer me directly". This process cannot bind port 5353 —
    // avahi already owns it on the host — so without this bit the answers would
    // go to a multicast group nothing here is listening on.
    assert.equal(parsed.questions[0].class, 0x8001);
  });
});

describe('parseDnsMessage + chromecastsFromDns', () => {
  const instance = 'Chromecast-abc123._googlecast._tcp.local';

  function response({ withAddress = true } = {}) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0);
    header.writeUInt16BE(0x8400, 2); // response, authoritative
    header.writeUInt16BE(1, 4); // one question, so the compression pointer below has a target
    header.writeUInt16BE(1, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(withAddress ? 3 : 2, 10);

    const question = Buffer.concat([
      encodeName('_googlecast._tcp.local'),
      Buffer.from([0x00, 0x0c, 0x00, 0x01]),
    ]);
    // The PTR's own name is a pointer back to the question at offset 12 — real
    // responders compress like this, and a parser that cannot follow it sees a
    // record for a device with a garbage name.
    const pointer = Buffer.from([0xc0, 0x0c]);
    const parts = [
      header,
      question,
      record(pointer, 12, encodeName(instance)),
      record(instance, 33, srv(8009, 'abc123.local')),
      record(instance, 16, txt(['id=abc123', 'md=Chromecast Ultra', 'fn=Tele del living'])),
    ];
    if (withAddress) parts.push(record('abc123.local', 1, Buffer.from([192, 168, 1, 44])));
    return Buffer.concat(parts);
  }

  test('follows name compression and pulls out the device the owner named', () => {
    const found = chromecastsFromDns(parseDnsMessage(response()));
    assert.deepEqual(found, [
      { name: 'Tele del living', model: 'Chromecast Ultra', address: '192.168.1.44', port: 8009 },
    ]);
  });

  test('falls back to the datagram source when the A record is missing', () => {
    const found = chromecastsFromDns(parseDnsMessage(response({ withAddress: false })), '10.0.0.5');
    assert.equal(found[0].address, '10.0.0.5');
    assert.equal(found[0].port, 8009);
  });

  test('a truncated message is an error, not a silent empty list', () => {
    assert.throws(() => parseDnsMessage(response().subarray(0, 20)));
  });
});
