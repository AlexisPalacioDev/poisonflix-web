// The one rule that keeps a host-networked discovery service from becoming an
// SSRF proxy: A DEVICE MAY ONLY SPEAK ABOUT ITSELF.
//
//   node --test "infra/cast-bridge/**/*.test.mjs"
//
// Why this file exists as its own suite rather than as a few cases inside
// discovery.test.mjs: that file is about what real televisions said. This one is
// about what a hostile one could say. The two read very differently and the
// fixtures below are deliberately implausible.
//
// The threat model, concretely. cast-bridge runs `network_mode: host`
// (docker-compose.yml explains why: multicast does not cross a bridge network),
// so its `fetch` reaches the host's 127.0.0.1, every docker gateway, the tailnet
// and the LAN. Discovery input is unauthenticated UDP. And the DLNA control URL
// is where adapters/dlna.mjs POSTs the media URL — which carries
// `api_key=<Jellyfin token>` in its query string. So a `<controlURL>` on
// somebody else's host is not a stray request: it is the token leaving.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import {
  acceptChromecasts,
  acceptSsdpResponse,
  buildDevices,
  fetchDescriptor,
  forbiddenAddressReason,
  normalizeHost,
  sameDeviceUrl,
} from './discovery.mjs';
import { play as dlnaPlay } from './adapters/dlna.mjs';
import { play as dialPlay, stop as dialStop } from './adapters/dial.mjs';

/** An SSDP 200 the way a device really sends it: CRLF, no body. */
function ssdpAnswer({ location, st = 'urn:schemas-upnp-org:service:AVTransport:1' }) {
  return [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    `LOCATION: ${location}`,
    'SERVER: Linux/4.1 UPnP/1.0 Hostile/1.0',
    `ST: ${st}`,
    'USN: uuid:deadbeef::urn:schemas-upnp-org:service:AVTransport:1',
    '',
    '',
  ].join('\r\n');
}

describe('normalizeHost', () => {
  test('an address has exactly one spelling', () => {
    assert.equal(normalizeHost('192.168.1.9'), '192.168.1.9');
    assert.equal(normalizeHost('[fe80::1]'), 'fe80::1');
    assert.equal(normalizeHost('FE80::1%eth0'), 'fe80::1');
    // The interesting one: this is 127.0.0.1 in a costume, and if the two
    // spellings can disagree the equality check downstream is decorative.
    assert.equal(normalizeHost('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeHost(null), '');
  });
});

describe('forbiddenAddressReason', () => {
  test('names the class that cannot be a television', () => {
    assert.equal(forbiddenAddressReason('127.0.0.1'), 'loopback');
    assert.equal(forbiddenAddressReason('127.53.1.1'), 'loopback');
    assert.equal(forbiddenAddressReason('::1'), 'loopback');
    assert.equal(forbiddenAddressReason('::ffff:127.0.0.1'), 'loopback');
    assert.equal(forbiddenAddressReason('169.254.10.2'), 'link-local');
    assert.equal(forbiddenAddressReason('fe80::abcd'), 'link-local');
    assert.equal(forbiddenAddressReason('239.255.255.250'), 'multicast');
    assert.equal(forbiddenAddressReason('224.0.0.251'), 'multicast');
    assert.equal(forbiddenAddressReason('0.0.0.0'), 'unspecified');
    assert.equal(forbiddenAddressReason('255.255.255.255'), 'broadcast');
    assert.equal(forbiddenAddressReason(''), 'empty');
  });

  test('every address a real screen could have is allowed', () => {
    // The false-negative side, and the reason this is a blocklist and not an
    // "only 192.168/16" allowlist: a refused television is indistinguishable
    // from the "No encontramos ningún dispositivo" bug this feature already had.
    for (const address of ['192.168.1.28', '10.0.0.5', '172.19.0.1', '100.101.102.103']) {
      assert.equal(forbiddenAddressReason(address), null, `${address} must be dialable`);
    }
  });
});

describe('sameDeviceUrl', () => {
  test('a relative controlURL resolves against the descriptor, as it must', () => {
    const { url } = sameDeviceUrl(
      '192.168.1.9',
      '/upnp/control/AVTransport1',
      'http://192.168.1.9:8200/rootDesc.xml',
    );
    assert.equal(url, 'http://192.168.1.9:8200/upnp/control/AVTransport1');
  });

  test('another PORT on the same address is still the same device', () => {
    // Not a concession: the Samsung serves its descriptor on 7678 and its DIAL
    // apps on 8080. Pinning the port would break real hardware.
    const { url } = sameDeviceUrl('192.168.1.28', 'http://192.168.1.28:8080/ws/app/');
    assert.equal(url, 'http://192.168.1.28:8080/ws/app/');
  });

  test('another HOST is refused, and says where it was pointing', () => {
    const { url, reason } = sameDeviceUrl(
      '192.168.1.9',
      'http://attacker.example/collect',
      'http://192.168.1.9:8200/rootDesc.xml',
    );
    assert.equal(url, null);
    assert.match(reason, /attacker\.example/);
    assert.match(reason, /192\.168\.1\.9/);
  });

  test('the host that matters is the one fetch would dial, not the one it reads like', () => {
    // `http://192.168.1.9@attacker.example/` LOOKS like the device to a human
    // and resolves to attacker.example. Userinfo is not a host.
    const { url } = sameDeviceUrl('192.168.1.9', 'http://192.168.1.9@attacker.example/x');
    assert.equal(url, null);
  });

  test('an absolute jump wins over the base, so the base is no defence', () => {
    const { url } = sameDeviceUrl(
      '192.168.1.9',
      'http://127.0.0.1:8096/Users',
      'http://192.168.1.9:8200/rootDesc.xml',
    );
    assert.equal(url, null);
  });

  test('only http(s)', () => {
    assert.equal(sameDeviceUrl('192.168.1.9', 'file:///etc/passwd').url, null);
    assert.equal(sameDeviceUrl('192.168.1.9', 'gopher://192.168.1.9:70/x').url, null);
  });
});

describe('acceptSsdpResponse', () => {
  test('a device that describes itself is kept', () => {
    const byLocation = new Map();
    const result = acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'http://192.168.1.9:8200/rootDesc.xml' }),
      '192.168.1.9',
    );
    assert.equal(result.accepted, true);
    assert.equal(byLocation.size, 1);
    const [entry] = [...byLocation.values()];
    assert.equal(entry.address, '192.168.1.9');
    assert.equal(entry.location, 'http://192.168.1.9:8200/rootDesc.xml');
  });

  test('a LOCATION on somebody else never enters the system', () => {
    // The whole attack in six lines: one UDP packet from a compromised bulb,
    // and every descriptor fetch, DIAL probe and DLNA POST that follows is
    // aimed wherever it said. Nothing downstream can undo this if it is stored.
    const byLocation = new Map();
    const result = acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'http://127.0.0.1:8096/System/Info' }),
      '192.168.1.77',
    );
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'cross-host');
    assert.equal(byLocation.size, 0);
  });

  test('an answer from loopback is refused whatever it says', () => {
    // Host networking makes this reachable: any local process can answer our
    // M-SEARCH from 127.0.0.1 and hand us a URL to the host's own services.
    const byLocation = new Map();
    const result = acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'http://127.0.0.1:8096/System/Info' }),
      '127.0.0.1',
    );
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'forbidden-source');
    assert.equal(byLocation.size, 0);
  });

  test('a non-http LOCATION is refused', () => {
    const byLocation = new Map();
    const result = acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'file:///etc/shadow' }),
      '192.168.1.9',
    );
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'cross-host');
    assert.equal(byLocation.size, 0);
  });

  test('the ordinary noise of ssdp:all is refused quietly, not loudly', () => {
    // These two codes are what tells scanSsdp not to log: they happen
    // constantly and burying the real refusals under them is how a guard stops
    // being readable.
    const byLocation = new Map();
    assert.equal(acceptSsdpResponse(byLocation, 'not ssdp at all', '192.168.1.9').code, 'not-ssdp');
    assert.equal(
      acceptSsdpResponse(byLocation, 'HTTP/1.1 200 OK\r\nST: x\r\n\r\n', '192.168.1.9').code,
      'no-location',
    );
  });
});

describe('buildDevices refuses what a hostile descriptor asks for', () => {
  const hostile = (controlURL) => ({
    address: '192.168.1.9',
    location: 'http://192.168.1.9:8200/rootDesc.xml',
    searchTargets: ['urn:schemas-upnp-org:service:AVTransport:1'],
    server: null,
    applicationUrl: null,
    dialProbe: null,
    descriptorError: null,
    descriptor: {
      friendlyName: 'Definitely A Television',
      modelName: 'TV-1',
      manufacturer: 'Acme',
      deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
      services: [{ serviceType: 'urn:schemas-upnp-org:service:AVTransport:1', controlURL }],
    },
  });

  test('a controlURL on another host is not a playable device', () => {
    // THE credential leak. dlna.mjs would POST SetAVTransportURI here with a
    // media URL carrying `api_key=<Jellyfin token>`.
    const [device] = buildDevices({ endpoints: [hostile('http://attacker.example:8200/collect')] });
    assert.equal(device.protocol, 'dlna');
    assert.equal(device.capability, 'none');
    assert.equal(device.endpoint.controlUrl, null);
    // Listed, not hidden — and the text says which of the two failures it is,
    // because "no publicó una dirección" and "publicó la de otro" are different
    // problems for whoever is holding the remote.
    assert.match(device.reason, /no le pertenece/);
  });

  test('a controlURL pointing at the host itself is not a playable device either', () => {
    const [device] = buildDevices({ endpoints: [hostile('http://127.0.0.1:8096/Users')] });
    assert.equal(device.capability, 'none');
    assert.equal(device.endpoint.controlUrl, null);
  });

  test('the honest relative controlURL still works', () => {
    const [device] = buildDevices({ endpoints: [hostile('/upnp/control/AVTransport1')] });
    assert.equal(device.capability, 'media');
    assert.equal(device.endpoint.controlUrl, 'http://192.168.1.9:8200/upnp/control/AVTransport1');
  });

  test('an Application-URL on another host is dropped, and the TV is still listed', () => {
    const [device] = buildDevices({
      endpoints: [
        {
          address: '192.168.1.28',
          location: 'http://192.168.1.28:7678/nservice/',
          searchTargets: ['urn:dial-multiscreen-org:device:dialreceiver:1'],
          server: null,
          applicationUrl: 'http://attacker.example:8080/ws/app/',
          dialProbe: { status: 200 },
          descriptorError: null,
          descriptor: {
            friendlyName: '65" QLED',
            modelName: 'QN65Q7FAAKXZL',
            manufacturer: 'Samsung Electronics',
            deviceType: 'urn:dial-multiscreen-org:device:dialreceiver:1',
            services: [],
          },
        },
      ],
    });
    assert.equal(device.protocol, 'dial');
    // dial.mjs POSTs to endpoint.applicationUrl. Null is the point.
    assert.equal(device.endpoint.applicationUrl, null);
    assert.equal(device.capability, 'none');
    assert.match(device.reason, /no le pertenece/);
  });
});

describe('fetchDescriptor', () => {
  test('a location that is not the device is never fetched at all', async () => {
    // Asserted against a REAL socket rather than a mock: the claim is that no
    // request is made, and only a server that could have received one can prove
    // it did not.
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<root/>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    try {
      const result = await fetchDescriptor(`http://127.0.0.1:${port}/rootDesc.xml`, '192.168.1.9');
      assert.equal(result.descriptor, null);
      assert.equal(result.applicationUrl, null);
      assert.match(result.error, /refused/);
      assert.equal(hits, 0, 'the guard must run BEFORE fetch, not after');
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test('a hostile Application-URL header is dropped, the descriptor is kept', async () => {
    // The header is not in the XML — it is a response header the device writes,
    // and probeDialApp fetches it on the very next line of scanDevices.
    const server = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/xml',
        'application-url': 'http://attacker.example:8080/ws/app/',
      });
      res.end(
        '<root><device><friendlyName>TV</friendlyName>' +
          '<deviceType>urn:dial-multiscreen-org:device:dialreceiver:1</deviceType>' +
          '</device></root>',
      );
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    try {
      const result = await fetchDescriptor(`http://127.0.0.1:${port}/rootDesc.xml`, '127.0.0.1');
      assert.equal(result.applicationUrl, null);
      // Dropping the header must not lose the device: it may still be a
      // renderer or a webOS set.
      assert.equal(result.descriptor.friendlyName, 'TV');
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test('an honest Application-URL survives', async () => {
    const server = createServer((req, res) => {
      const { port } = server.address();
      res.writeHead(200, {
        'content-type': 'text/xml',
        'application-url': `http://127.0.0.1:${port}/ws/app/`,
      });
      res.end('<root><device><friendlyName>TV</friendlyName></device></root>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    try {
      const result = await fetchDescriptor(`http://127.0.0.1:${port}/rootDesc.xml`, '127.0.0.1');
      assert.equal(result.applicationUrl, `http://127.0.0.1:${port}/ws/app/`);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe('a redirect must not undo the host check', () => {
  // The subtle half of the rule, and the one the first pass at this fix missed.
  // Every check in this file runs on the URL the code decides to SEND. `fetch`
  // defaults to `redirect: 'follow'`, so a device that passes the check and then
  // answers `302 Location: http://somewhere.else/` gets fetched there anyway —
  // the guard would be describing a request that never happened. bff/cast.mjs
  // already carries `redirect: 'error'` and a comment explaining exactly this;
  // the bridge did not.

  /** Two servers: one that redirects, one that must never be reached. */
  async function redirectPair(status) {
    let sinkHits = 0;
    let sinkBody = '';
    const sink = createServer((req, res) => {
      sinkHits += 1;
      req.on('data', (c) => {
        sinkBody += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end('<root/>');
      });
    });
    await new Promise((done) => sink.listen(0, '127.0.0.1', done));
    const sinkUrl = `http://127.0.0.1:${sink.address().port}/collect`;

    const front = createServer((req, res) => {
      res.writeHead(status, { location: sinkUrl });
      res.end();
    });
    await new Promise((done) => front.listen(0, '127.0.0.1', done));

    return {
      frontUrl: `http://127.0.0.1:${front.address().port}/rootDesc.xml`,
      hits: () => sinkHits,
      body: () => sinkBody,
      close: async () => {
        await new Promise((done) => front.close(done));
        await new Promise((done) => sink.close(done));
      },
    };
  }

  test('fetchDescriptor refuses a 302 instead of chasing it', async () => {
    const pair = await redirectPair(302);
    try {
      const result = await fetchDescriptor(pair.frontUrl, '127.0.0.1');
      assert.equal(result.descriptor, null);
      assert.equal(pair.hits(), 0, 'the redirect target must never be fetched');
    } finally {
      await pair.close();
    }
  });

  test('a 307 never gets to re-send the SOAP body, api_key and all', async () => {
    // The whole point. A 307/308 preserves the METHOD AND THE BODY, and this
    // body is `SetAVTransportURI` carrying a media URL with
    // `api_key=<Jellyfin token>` in its query string.
    const pair = await redirectPair(307);
    const mediaUrl = 'http://poisonflix.local/Videos/7/stream?api_key=SUPER-SECRET-TOKEN';
    try {
      const result = await dlnaPlay(
        { address: '127.0.0.1', endpoint: { controlUrl: pair.frontUrl } },
        { mediaUrl, title: 'La película' },
      );
      assert.equal(result.ok, false);
      assert.equal(pair.hits(), 0, 'the redirect target must never be POSTed to');
      assert.ok(
        !pair.body().includes('SUPER-SECRET-TOKEN'),
        'the Jellyfin token must never leave for a host the device chose',
      );
    } finally {
      await pair.close();
    }
  });
});

describe('every outbound fetch in the bridge refuses redirects', () => {
  // An audit of the first version of this fix deleted `redirect: 'error'` from
  // probeDialApp, from dial.play, from dial's state GET and from its DELETE —
  // one at a time — and got 134 passing tests every time. Only two of the six
  // call sites had a behavioural test. A rule written six times and protected
  // twice is a rule somebody reopens by accident in a green build.
  //
  // So this one reads the source. Crude, and deliberately so: it is the only
  // check that covers a call site nobody has written a socket test for — and
  // the only one that will cover the NEXT fetch someone adds to this service.

  const SOURCES = [
    '../cast-bridge/discovery.mjs',
    '../cast-bridge/adapters/dial.mjs',
    '../cast-bridge/adapters/dlna.mjs',
    '../cast-bridge/adapters/cast.mjs',
    '../cast-bridge/adapters/ssap.mjs',
    '../cast-bridge/server.mjs',
    '../cast-bridge/mime.mjs',
    '../cast-bridge/xml.mjs',
    '../cast-bridge/log.mjs',
  ];

  /** Every `fetch(` call and the option object that follows it. */
  function fetchCallSites(source) {
    const sites = [];
    const re = /\bfetch\(/g;
    let match;
    while ((match = re.exec(source))) {
      // No fetch call in this codebase nests another, so the first `});` after
      // the call closes its options object.
      const end = source.indexOf('});', match.index);
      const upTo = end === -1 ? match.index + 500 : end;
      const line = source.slice(0, match.index).split('\n').length;
      sites.push({ line, text: source.slice(match.index, upTo) });
    }
    return sites;
  }

  test('all six of them, named individually when one is missing', async () => {
    const found = [];
    for (const rel of SOURCES) {
      const path = new URL(rel, import.meta.url);
      const source = await readFile(path, 'utf8');
      for (const site of fetchCallSites(source)) {
        found.push({ file: rel.replace('../cast-bridge/', ''), ...site });
      }
    }

    // Guards the heuristic itself: if this number moves, either somebody added
    // a fetch (and it needs the option) or the scan stopped seeing them (and
    // this test quietly stopped testing anything).
    assert.equal(
      found.length,
      6,
      `expected 6 fetch call sites, found ${found.length}: ${found
        .map((f) => `${f.file}:${f.line}`)
        .join(', ')}`,
    );

    const unguarded = found.filter((site) => !site.text.includes("redirect: 'error'"));
    assert.deepEqual(
      unguarded.map((site) => `${site.file}:${site.line}`),
      [],
      'a fetch that follows redirects hands the same-host check straight back to the device',
    );
  });
});

describe('dial.play does not re-POST its body to a redirect', () => {
  test('a 307 from the TV cannot move the launch payload to another host', async () => {
    // Same class as the DLNA leak: a 307/308 preserves method AND body, and
    // this body is `url=<the page to open>&title=...`. This is one of the four
    // call sites the audit proved nothing was watching.
    let stolen = 0;
    const sink = createServer((req, res) => {
      stolen += 1;
      res.writeHead(201);
      res.end();
    });
    await new Promise((done) => sink.listen(0, '127.0.0.1', done));

    const front = createServer((req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/stolen` });
      res.end();
    });
    await new Promise((done) => front.listen(0, '127.0.0.1', done));

    try {
      const device = {
        address: '127.0.0.1',
        endpoint: {
          applicationUrl: `http://127.0.0.1:${front.address().port}/ws/app/`,
          app: 'PoisonFlix',
        },
      };
      const result = await dialPlay(device, { appUrl: 'https://poisonflix.example/watch/12' });
      assert.equal(result.ok, false);
      assert.equal(stolen, 0, 'the redirect target must never receive the launch payload');
    } finally {
      await new Promise((done) => front.close(done));
      await new Promise((done) => sink.close(done));
    }
  });
});

describe('dial.stop refuses a run link that is not the TV', () => {
  async function fakeTv(runHref) {
    let deleted = null;
    const server = createServer((req, res) => {
      if (req.method === 'DELETE') {
        deleted = req.url;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(
        '<service xmlns="urn:dial-multiscreen-org:schemas:dial">' +
          '<name>PoisonFlix</name><state>running</state>' +
          `<link rel="run" href="${runHref}"/>` +
          '</service>',
      );
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const device = {
      address: '127.0.0.1',
      endpoint: {
        applicationUrl: `http://127.0.0.1:${server.address().port}/ws/app/`,
        app: 'PoisonFlix',
      },
    };
    return { device, deleted: () => deleted, close: () => new Promise((d) => server.close(d)) };
  }

  test('a run link on another host is refused, with a reason', async () => {
    // `runHref` is an attribute of XML the television served: one more URL the
    // device chose, and the only one the first pass at this fix left unchecked.
    const tv = await fakeTv('http://attacker.example/run');
    try {
      const result = await dialStop(tv.device);
      assert.equal(result.ok, false);
      assert.match(result.reason, /no le pertenece/);
      assert.equal(tv.deleted(), null);
    } finally {
      await tv.close();
    }
  });

  test('the ordinary relative run link still stops the app', async () => {
    const tv = await fakeTv('run');
    try {
      assert.deepEqual(await dialStop(tv.device), { ok: true });
      assert.equal(tv.deleted(), '/ws/app/PoisonFlix/run');
    } finally {
      await tv.close();
    }
  });
});

describe('what the same-host rule deliberately gives up', () => {
  // Pinned, not discovered. An audit pointed out that "this does not break real
  // televisions" was assumed and never measured, so the two cases where it DOES
  // refuse a plausible device are written down here as decisions. If a set in
  // this house ever goes missing from the list, this is the first suspect and
  // the log line named in each case is where to look.

  test('a LOCATION published as a hostname is refused', () => {
    // UPnP devices publish IP literals in practice (there is no DNS a device
    // can rely on), but the spec does not forbid a name. Comparing a name to a
    // source IP can only fail, so such a device disappears from the list — with
    // a `discovery.ssdp` log line saying so, which is the whole difference
    // between a diagnosable absence and "my TV is not there".
    //
    // The upside of the same limitation: DNS rebinding is impossible here by
    // construction. A hostname can never equal a source IP, so it is refused
    // before anything resolves it — there is no window between check and fetch.
    const byLocation = new Map();
    const result = acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'http://LivingRoomTV.local:8200/desc.xml' }),
      '192.168.1.9',
    );
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'cross-host');
  });

  test('a device answering from one interface and publishing another is refused', () => {
    // A dual-homed set (wifi + ethernet) that answers from 192.168.1.9 and
    // publishes its 192.168.2.9 descriptor is refused. Accepting it would mean
    // accepting "this other address is also me", which is exactly the claim the
    // rule exists to refuse — there is no way to tell it from an attacker
    // making the same claim.
    const byLocation = new Map();
    const result = acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'http://192.168.2.9:8200/desc.xml' }),
      '192.168.1.9',
    );
    assert.equal(result.accepted, false);
  });

  test('a spoofed source address still cannot aim a request at the attacker', () => {
    // The honest limit of the rule, spelled out. A UDP source address IS
    // forgeable and the M-SEARCH is multicast, so anyone on the LAN can answer
    // as somebody else. What they cannot do is receive at an address they do
    // not hold: every URL that survives points at the address that was claimed.
    // Blind SSRF survives; exfiltration does not, and exfiltration is what the
    // Jellyfin api_key makes expensive.
    const byLocation = new Map();
    acceptSsdpResponse(
      byLocation,
      ssdpAnswer({ location: 'http://192.168.1.50:8096/System/Info' }),
      '192.168.1.50',
    );
    const [entry] = [...byLocation.values()];
    assert.equal(entry.address, '192.168.1.50');
    // Whatever else it asks for later, it can only ask on its own claimed host.
    assert.equal(sameDeviceUrl(entry.address, 'http://attacker.example/x').url, null);
  });
});

describe('acceptChromecasts', () => {
  const message = (aRecordAddress) => ({
    records: [
      { type: 12, name: '_googlecast._tcp.local', data: 'tv._googlecast._tcp.local' },
      {
        type: 33,
        name: 'tv._googlecast._tcp.local',
        data: { target: 'tv.local', port: 8009, priority: 0, weight: 0 },
      },
      { type: 1, name: 'tv.local', data: aRecordAddress },
      { type: 16, name: 'tv._googlecast._tcp.local', data: ['fn=Tele del living'] },
    ],
  });

  test('the chromecast that answered is kept', () => {
    const found = acceptChromecasts(message('192.168.1.44'), '192.168.1.44');
    assert.equal(found.length, 1);
    assert.equal(found[0].address, '192.168.1.44');
    assert.equal(found[0].name, 'Tele del living');
  });

  test('an A record naming somebody else is dropped', () => {
    // cast.mjs opens a TLS socket to this address and sends it the media URL.
    // The A record is written by the sender; the source address is not.
    assert.deepEqual(acceptChromecasts(message('127.0.0.1'), '192.168.1.44'), []);
    assert.deepEqual(acceptChromecasts(message('10.9.9.9'), '192.168.1.44'), []);
  });

  test('an answer from an address no screen can have is dropped', () => {
    assert.deepEqual(acceptChromecasts(message('127.0.0.1'), '127.0.0.1'), []);
  });
});
