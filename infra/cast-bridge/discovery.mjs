// poisonflix cast-bridge discovery — what is on the LAN, and what each thing can
// actually be asked to do with a URL.
//
// Two protocols, because the living room has two kinds of screen: SSDP/UPnP
// (Samsung's DIAL receiver, LG's webOS, anything with an AVTransport service)
// and mDNS (Chromecast, which does not answer SSDP at all).
//
// No XML library. A UPnP device descriptor is a flat document we read four
// fields out of, and the alternative is an npm dependency in a service whose
// whole point is that it has none. The regexes below are anchored on the tags
// they want and tolerate a namespace prefix; what they do NOT tolerate is being
// pointed at arbitrary XML and asked to be a parser. `&quot;` is unescaped for
// real and not defensively: the Samsung on this LAN answers with the
// friendlyName `65&quot; QLED`, so a device would otherwise be listed with raw
// entities in its name.

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import { logError, logInfo } from './log.mjs';
import { decodeXmlEntities, firstTag } from './xml.mjs';

// Re-exported because the descriptor tests read entities through this module,
// and because "which XML helper does discovery use" should have one answer.
export { decodeXmlEntities };

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const CAST_SERVICE = '_googlecast._tcp.local';
const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';

// How long one scan listens for answers. Short on purpose: the player screen
// asks for the list every time it opens, and a discovery call that takes five
// seconds is a spinner nobody waits through. The cache in server.mjs is what
// keeps repeated opens from paying this at all.
const SCAN_TIMEOUT_MS = Number(process.env.CAST_SCAN_TIMEOUT_MS || 2_500);
// A descriptor is ~2 KB served by a TV's tiny embedded HTTP server. The budget
// is generous because a sleeping TV answers slowly, not because the file is big.
const DESCRIPTOR_TIMEOUT_MS = Number(process.env.CAST_DESCRIPTOR_TIMEOUT_MS || 2_500);
// The name our app is registered under in the TV's DIAL app list. Configurable
// because "the app is called PoisonFlix" is a fact about the app store entry,
// not about this code.
const DIAL_APP = process.env.CAST_DIAL_APP || 'PoisonFlix';
// webOS's SSAP endpoint. 3000 is plain ws://, 3001 is wss:// with a self-signed
// certificate; 3000 avoids the certificate question entirely on a LAN hop.
const SSAP_PORT = Number(process.env.CAST_SSAP_PORT || 3000);
// A device descriptor that is not a couple of kilobytes is not a descriptor.
// `fetch` will happily buffer whatever a LAN device decides to send, and this
// process talks to devices nobody here controls.
const MAX_DESCRIPTOR_BYTES = 512 * 1024;

// `ssdp:all` finds everything that speaks UPnP, and the two targeted searches
// exist because some devices only answer a search for the exact type they
// implement — the Samsung's DIAL receiver among them.
const SEARCH_TARGETS = [
  'ssdp:all',
  'urn:dial-multiscreen-org:device:dialreceiver:1',
  AV_TRANSPORT,
];

// ---------------------------------------------------------------------------
// Pure parsing — everything below this line is what the tests drive.
// ---------------------------------------------------------------------------

/** Every `<service>` block, as `{ serviceType, controlURL }`. */
function parseServices(xml) {
  const services = [];
  const re = /<(?:[\w.-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?service>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    const serviceType = firstTag(block, 'serviceType');
    if (!serviceType) continue;
    services.push({ serviceType, controlURL: firstTag(block, 'controlURL') });
  }
  return services;
}

/** A UPnP device descriptor, reduced to the five things this service uses. */
export function parseDescriptor(xml) {
  const text = String(xml);
  return {
    friendlyName: firstTag(text, 'friendlyName'),
    modelName: firstTag(text, 'modelName'),
    manufacturer: firstTag(text, 'manufacturer'),
    deviceType: firstTag(text, 'deviceType'),
    services: parseServices(text),
  };
}

/** An SSDP response's headers, lowercased. null when it is not one. */
export function parseSsdpResponse(text) {
  const lines = String(text).split(/\r?\n/);
  const statusLine = (lines.shift() || '').trim();
  if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) return null;
  const headers = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    // First value wins. A device repeating a header is answering the same
    // question twice, and the second answer is not more true than the first.
    if (key in headers) continue;
    headers[key] = line.slice(idx + 1).trim();
  }
  return { statusLine, headers };
}

/** Absolute URL for a descriptor-relative `controlURL`, or null. */
export function resolveUrl(base, ref) {
  if (!ref) return null;
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// A device may only speak about itself
// ---------------------------------------------------------------------------
//
// Every URL this process fetches was written by something on the LAN: a UDP
// datagram nobody authenticated, or an XML document served by a television. And
// this container runs with `network_mode: host` (see docker-compose.yml), so
// its `fetch` reaches the host's own 127.0.0.1, every docker bridge gateway,
// the tailnet and the whole LAN. Anything able to put one packet on the wire —
// a compromised bulb, a guest phone — could answer an M-SEARCH with
// `LOCATION: http://127.0.0.1:8096/...` and have this service fetch it, then
// read the result out of the device list.
//
// The DLNA path is worse than a probe. `buildDevices` hands the resolved
// `<controlURL>` to adapters/dlna.mjs, which POSTs the media URL to it — and
// that URL carries `api_key=<Jellyfin token>` in its query string. A control
// URL pointing at a host the attacker owns is credential exfiltration.
//
// The rule below is the smallest one that keeps casting working: a device may
// only make this process talk to ITSELF. The host in LOCATION must be the IP
// the datagram came from, and every URL derived from that device's descriptor
// must stay on that same host. PORTS are free on purpose — a TV really does
// serve its descriptor on one port and its AVTransport control on another, and
// another port on the device's own address is still the device.

/** Comparable form of a host: no brackets, no zone id, no v4-mapped disguise. */
export function normalizeHost(host) {
  let value = String(host ?? '')
    .trim()
    .toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  // `fe80::1%eth0` — the interface is routing, not identity.
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  // `::ffff:127.0.0.1` is 127.0.0.1 wearing a different suit. The two spellings
  // must never be able to disagree about whether they are the same host, or the
  // second one walks straight through the equality check below.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return mapped ? mapped[1] : value;
}

// Address classes a television never has, and every SSRF wants. Kept as a list
// rather than one regex so the log can name WHICH class was refused.
const FORBIDDEN_ADDRESSES = [
  [/^127\./, 'loopback'],
  [/^::1$/, 'loopback'],
  [/^0\./, 'unspecified'],
  [/^::$/, 'unspecified'],
  [/^169\.254\./, 'link-local'],
  [/^fe[89ab][0-9a-f]:/, 'link-local'],
  [/^22[4-9]\./, 'multicast'],
  [/^23[0-9]\./, 'multicast'],
  [/^ff[0-9a-f]{2}:/, 'multicast'],
  [/^255\.255\.255\.255$/, 'broadcast'],
];

/**
 * Why this address must never be dialed, or null when it is a plausible device.
 *
 * DELIBERATELY not an "only RFC1918" allowlist. This host is on a tailnet
 * (100.64.0.0/10) and home LANs are not all 192.168.x, so an allowlist would
 * refuse real televisions — a false negative that looks exactly like the
 * "No encontramos ningún dispositivo" bug this feature already had. What is
 * listed here instead is only what CANNOT be a TV: loopback (the host's own
 * services, the whole point of the attack), the unspecified and broadcast
 * addresses, link-local, and multicast groups.
 */
export function forbiddenAddressReason(address) {
  const host = normalizeHost(address);
  if (!host) return 'empty';
  for (const [pattern, why] of FORBIDDEN_ADDRESSES) {
    if (pattern.test(host)) return why;
  }
  return null;
}

/**
 * `ref` (optionally relative to `base`) as an absolute URL, but ONLY if it
 * stays on `address` and speaks HTTP.
 *
 * Returns `{ url, reason }`: `url` is null when refused and `reason` says why,
 * because every call site has to log the refusal rather than drop a device in
 * silence — "my TV is not in the list" must always be diagnosable.
 *
 * No address-class check here on purpose: that is done ONCE, in
 * `acceptSsdpResponse`, against the source of the datagram. Past that point
 * every host is compared to an address that was already vetted, so repeating
 * the class check would only make the rule harder to test.
 */
export function sameDeviceUrl(address, ref, base = null) {
  if (!ref) return { url: null, reason: 'no URL' };
  const host = normalizeHost(address);
  if (!host) return { url: null, reason: 'no source address to compare against' };

  let parsed;
  try {
    parsed = base ? new URL(ref, base) : new URL(ref);
  } catch {
    return { url: null, reason: `not a URL: ${ref}` };
  }
  // A device that answers SSDP over `file:` or `gopher:` is not a device.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, reason: `scheme ${parsed.protocol} is not http(s)` };
  }
  const target = normalizeHost(parsed.hostname);
  if (target !== host) {
    return { url: null, reason: `points at ${target}, not at ${host}` };
  }
  return { url: parsed.href, reason: null };
}

/**
 * `Application-URL` + app name.
 *
 * The header may or may not end in a slash — the Samsung's does
 * (`http://192.168.1.28:8080/ws/app/`) — and `new URL('PoisonFlix', base)`
 * would silently drop the last path segment when it does not.
 */
export function appResourceUrl(applicationUrl, app) {
  const base = String(applicationUrl);
  return base.endsWith('/') ? `${base}${app}` : `${base}/${app}`;
}

/**
 * What a DIAL probe means.
 *
 * This is the whole DIAL decision: the app resource answering 200 is the TV
 * saying "I have that app installed", and 404 is it saying it does not. Both
 * are listed — the 404 case is exactly the device that must NOT disappear from
 * the list, because "my TV is not there" and "my TV needs the app installed"
 * look identical to whoever is holding the remote.
 */
export function classifyDial(probe) {
  // No probe at all: the TV published where its apps live and the question was
  // never asked. Unreachable from `scanDevices` (it always probes when there is
  // an Application-URL), and still not silence — an unusable entry without a
  // reason is the one shape this list is not allowed to have.
  if (!probe) {
    return { capability: 'none', reason: 'No se pudo consultar si la TV tiene la app instalada.' };
  }
  if (probe.status === 200 || probe.status === 201) return { capability: 'app' };
  if (probe.status === 404) {
    return {
      capability: 'none',
      reason: `Esta TV no tiene la app ${DIAL_APP} instalada. Instalala desde la tienda de la TV y volvé a escanear.`,
    };
  }
  if (probe.status === null) {
    return {
      capability: 'none',
      reason: 'La TV no respondió cuando le preguntamos por la app. Fijate que esté encendida y volvé a escanear.',
    };
  }
  return {
    capability: 'none',
    reason: `La TV respondió ${probe.status} al preguntarle por la app ${DIAL_APP}, así que no se puede saber si está instalada.`,
  };
}

function findService(descriptor, serviceType) {
  if (!descriptor) return null;
  const wanted = serviceType.toLowerCase();
  return descriptor.services.find((s) => s.serviceType.toLowerCase() === wanted) || null;
}

/**
 * webOS is identified by the `WebOS/x.y` token SSDP puts in the SERVER header
 * (`SERVER: ... WebOS/4.1.0 UPnP/1.0` is what the TV on this LAN sends).
 *
 * Deliberately NOT "manufacturer says LG": LG's pre-webOS sets (NetCast) also
 * say LG and do not speak SSAP on 3000, and offering a protocol a TV does not
 * implement produces a device that is listed, selectable, and silently does
 * nothing — the exact failure mode this service is supposed to make impossible.
 */
function isWebOs(endpoint) {
  const server = String(endpoint.server || '');
  const model = String(endpoint.descriptor?.modelName || '');
  return /webos/i.test(server) || /webos/i.test(model);
}

function deviceName(endpoint) {
  // The address is a poor name and a correct one; a Spanish placeholder here
  // would be the only user-visible string outside `reason`.
  return endpoint.descriptor?.friendlyName || endpoint.address;
}

/**
 * Turn everything a scan gathered into the list the API answers with.
 *
 * Pure on purpose — this is where every "is it usable and why not" decision
 * lives, and it is the part worth testing against the descriptors real devices
 * actually sent.
 *
 * One device can produce several entries (the same TV is a DIAL receiver AND a
 * DLNA renderer) and they are NOT merged: they have different ids because they
 * do different things, and the caller picks by capability.
 */
export function buildDevices({ endpoints = [], chromecasts = [] } = {}) {
  const devices = [];

  for (const endpoint of endpoints) {
    const name = deviceName(endpoint);
    const model = endpoint.descriptor?.modelName || undefined;
    const targets = (endpoint.searchTargets || []).join(' ');
    const descriptorType = endpoint.descriptor?.deviceType || '';

    // --- DIAL -------------------------------------------------------------
    const announcesDial = /dialreceiver/i.test(targets) || /dialreceiver/i.test(descriptorType);
    // `Application-URL` is a RESPONSE HEADER the device writes, and adapters/
    // dial.mjs POSTs to whatever ends up in `endpoint.applicationUrl`. It is
    // filtered again here, after `fetchDescriptor` already filtered it, because
    // this is the function that decides what the adapters are handed — and it
    // is the one a test can hold still.
    const applicationUrl = sameDeviceUrl(endpoint.address, endpoint.applicationUrl).url;
    if (endpoint.applicationUrl && !applicationUrl) {
      logInfo('discovery.dial', 'Application-URL discarded: a device may only speak about itself', {
        address: endpoint.address,
        applicationUrl: endpoint.applicationUrl,
      });
    }
    if (endpoint.applicationUrl || announcesDial) {
      const verdict = applicationUrl
        ? classifyDial(endpoint.dialProbe)
        : {
            capability: 'none',
            // It answered a search for `dialreceiver` and then its descriptor
            // came back without the header that says where the apps live — or
            // with one pointing at somebody else, which is the same to whoever
            // is holding the remote and worth separating in the text.
            reason: endpoint.applicationUrl
              ? 'La TV publicó una dirección de apps que no le pertenece, así que no se le puede abrir nada.'
              : 'La TV se anuncia como receptor DIAL pero no publicó la dirección de sus apps.',
          };
      devices.push({
        id: `dial:${endpoint.address}`,
        name,
        address: endpoint.address,
        protocol: 'dial',
        capability: verdict.capability,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(model ? { model } : {}),
        endpoint: { applicationUrl: applicationUrl || null, app: DIAL_APP },
      });
    }

    // --- DLNA / AVTransport ----------------------------------------------
    const avTransport = findService(endpoint.descriptor, AV_TRANSPORT);
    if (avTransport) {
      // THE credential sink. adapters/dlna.mjs POSTs `SetAVTransportURI` here
      // with a media URL that carries `api_key=<Jellyfin token>`, so a
      // `<controlURL>` pointing at another host is not a stray request — it is
      // the token leaving the LAN. `sameDeviceUrl` instead of `resolveUrl`
      // keeps a relative controlURL working (they nearly all are) while
      // refusing an absolute one that jumps hosts.
      const control = sameDeviceUrl(endpoint.address, avTransport.controlURL, endpoint.location);
      const controlUrl = control.url;
      if (avTransport.controlURL && !controlUrl) {
        logInfo('discovery.dlna', 'controlURL discarded: a device may only speak about itself', {
          address: endpoint.address,
          location: endpoint.location,
          controlURL: avTransport.controlURL,
          reason: control.reason,
        });
      }
      devices.push({
        id: `dlna:${endpoint.address}`,
        name,
        address: endpoint.address,
        protocol: 'dlna',
        capability: controlUrl ? 'media' : 'none',
        ...(controlUrl
          ? {}
          : {
              reason: avTransport.controlURL
                ? 'El dispositivo publicó una dirección de control que no le pertenece, así que no se le puede mandar nada.'
                : 'El dispositivo dice poder reproducir video pero no publicó a qué dirección mandárselo.',
            }),
        ...(model ? { model } : {}),
        endpoint: { controlUrl },
      });
    } else if (/AVTransport/i.test(targets) && !endpoint.descriptor) {
      // It answered a search for AVTransport and then its descriptor could not
      // be read, so nothing here has SEEN the service declared. The contract is
      // explicit about this case — "si el descriptor no declara AVTransport, NO
      // lo listes como dlna" — and it wins over the instinct to list it with a
      // reason, because an entry whose control URL is unknown cannot be played
      // to no matter what the person taps.
      //
      // It is still not silence: this line names the device that was one
      // readable descriptor away from being usable, which is what turns "my TV
      // is not in the list" into something diagnosable.
      logInfo('discovery.dlna', 'AVTransport announced but the descriptor could not be read', {
        address: endpoint.address,
        location: endpoint.location,
        error: endpoint.descriptorError || 'no response',
      });
    }

    // --- SSAP (LG webOS) --------------------------------------------------
    if (isWebOs(endpoint)) {
      devices.push({
        id: `ssap:${endpoint.address}`,
        name,
        address: endpoint.address,
        protocol: 'ssap',
        // webOS opens a URL through its own browser, so this does not depend on
        // an app being installed the way DIAL does.
        capability: 'app',
        ...(model ? { model } : {}),
        endpoint: { port: SSAP_PORT },
      });
    }
  }

  for (const cast of chromecasts) {
    if (!cast.address) continue;
    devices.push({
      id: `cast:${cast.address}`,
      name: cast.name || cast.address,
      address: cast.address,
      protocol: 'cast',
      capability: 'media',
      ...(cast.model ? { model: cast.model } : {}),
      endpoint: { port: cast.port || 8009 },
    });
  }

  return dedupe(devices).sort(
    (a, b) => a.name.localeCompare(b.name) || a.protocol.localeCompare(b.protocol),
  );
}

/**
 * One entry per id. A device answers the same search from several LOCATIONs
 * (webOS publishes a handful of descriptors), and only one of them may be the
 * one that carries the usable service — so a usable entry always displaces an
 * unusable one rather than losing a coin flip on arrival order.
 */
function dedupe(devices) {
  const byId = new Map();
  for (const device of devices) {
    const existing = byId.get(device.id);
    if (!existing || (existing.capability === 'none' && device.capability !== 'none')) {
      byId.set(device.id, device);
    }
  }
  return [...byId.values()];
}

/** The wire shape from the contract — `endpoint` is ours and stays here. */
export function toPublicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    address: device.address,
    protocol: device.protocol,
    capability: device.capability,
    ...(device.reason ? { reason: device.reason } : {}),
    ...(device.model ? { model: device.model } : {}),
  };
}

// ---------------------------------------------------------------------------
// DNS / mDNS wire format — also pure, also tested.
// ---------------------------------------------------------------------------

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

/**
 * A one-question query for `name`.
 *
 * QCLASS carries the QU bit (0x8000): "answer me directly, not to the multicast
 * group". We ask for that because this socket is NOT bound to port 5353 — the
 * host already has an mDNS responder sitting on it (avahi), and fighting it for
 * the port would break name resolution for the whole machine. RFC 6762 §6.7
 * also requires a responder to answer a query coming from a non-5353 source
 * port directly to that port, so the reply reaches us either way.
 */
export function buildMdnsQuery(name, { type = TYPE_PTR, id = 0 } = {}) {
  const labels = String(name)
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean);
  const parts = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0); // transaction id
  header.writeUInt16BE(0, 2); // flags: standard query
  header.writeUInt16BE(1, 4); // qdcount
  parts.push(header);
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new Error(`label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  const tail = Buffer.alloc(5);
  tail.writeUInt8(0, 0); // root label
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(0x8000 | 1, 3); // QU | IN
  parts.push(tail);
  return Buffer.concat(parts);
}

/**
 * Read a (possibly compressed) name.
 *
 * The jump budget is not paranoia about hostile devices so much as about buggy
 * ones: a pointer loop in a malformed packet is an infinite loop inside a
 * service that has to keep answering HTTP.
 */
function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated name pointer');
      if (next === -1) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      if (++jumps > 64) throw new Error('name pointer loop');
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated label');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

function readRecord(buf, offset) {
  const { name, next } = readName(buf, offset);
  if (next + 10 > buf.length) throw new Error('truncated record header');
  const type = buf.readUInt16BE(next);
  const klass = buf.readUInt16BE(next + 2);
  const ttl = buf.readUInt32BE(next + 4);
  const length = buf.readUInt16BE(next + 8);
  const start = next + 10;
  const end = start + length;
  if (end > buf.length) throw new Error('truncated record data');

  let data = null;
  if (type === TYPE_A && length === 4) {
    data = `${buf[start]}.${buf[start + 1]}.${buf[start + 2]}.${buf[start + 3]}`;
  } else if (type === TYPE_PTR) {
    data = readName(buf, start).name;
  } else if (type === TYPE_SRV && length >= 6) {
    data = {
      priority: buf.readUInt16BE(start),
      weight: buf.readUInt16BE(start + 2),
      port: buf.readUInt16BE(start + 4),
      // Target names are compressed against the whole message, so this is read
      // from the message and not from the record slice.
      target: readName(buf, start + 6).name,
    };
  } else if (type === TYPE_TXT) {
    const entries = [];
    let pos = start;
    while (pos < end) {
      const len = buf[pos];
      if (pos + 1 + len > end) break;
      entries.push(buf.toString('utf8', pos + 1, pos + 1 + len));
      pos += 1 + len;
    }
    data = entries;
  }

  return { record: { name, type, class: klass & 0x7fff, ttl, data }, next: end };
}

/** Header + questions + all three record sections. */
export function parseDnsMessage(buf) {
  if (buf.length < 12) throw new Error('short dns message');
  const counts = {
    questions: buf.readUInt16BE(4),
    answers: buf.readUInt16BE(6),
    authorities: buf.readUInt16BE(8),
    additionals: buf.readUInt16BE(10),
  };
  let pos = 12;
  const questions = [];
  for (let i = 0; i < counts.questions; i += 1) {
    const { name, next } = readName(buf, pos);
    if (next + 4 > buf.length) throw new Error('truncated question');
    questions.push({ name, type: buf.readUInt16BE(next), class: buf.readUInt16BE(next + 2) });
    pos = next + 4;
  }
  const records = [];
  const total = counts.answers + counts.authorities + counts.additionals;
  for (let i = 0; i < total && pos < buf.length; i += 1) {
    const { record, next } = readRecord(buf, pos);
    records.push(record);
    pos = next;
  }
  return { id: buf.readUInt16BE(0), flags: buf.readUInt16BE(2), questions, records };
}

/** `fn=Living room TV` -> `{ fn: 'Living room TV' }`. */
function parseTxt(entries) {
  const out = {};
  for (const entry of entries || []) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    out[entry.slice(0, idx).toLowerCase()] = entry.slice(idx + 1);
  }
  return out;
}

/**
 * Chromecasts described by one mDNS answer.
 *
 * `fallbackAddress` is the IP the datagram came from: a responder is allowed to
 * leave the A record out when it thinks we already know it, and a Chromecast
 * with no address is a device that cannot be cast to — dropping it silently is
 * exactly the failure this service refuses to have.
 */
export function chromecastsFromDns(message, fallbackAddress = null) {
  const instances = new Set();
  for (const record of message.records) {
    if (record.type === TYPE_PTR && record.name === CAST_SERVICE && record.data) {
      instances.add(record.data);
    }
  }
  // A unicast reply to our PTR question sometimes arrives with the SRV/TXT of a
  // single instance and no PTR at all; treat those as instances too.
  for (const record of message.records) {
    if (
      (record.type === TYPE_SRV || record.type === TYPE_TXT) &&
      record.name.endsWith(`.${CAST_SERVICE}`)
    ) {
      instances.add(record.name);
    }
  }

  const found = [];
  for (const instance of instances) {
    const srv = message.records.find((r) => r.type === TYPE_SRV && r.name === instance);
    const txt = parseTxt(
      message.records.find((r) => r.type === TYPE_TXT && r.name === instance)?.data,
    );
    const a = srv?.data?.target
      ? message.records.find((r) => r.type === TYPE_A && r.name === srv.data.target)
      : null;
    const address = a?.data || fallbackAddress;
    if (!address) continue;
    found.push({
      // `fn` is the name the owner typed into the Google Home app; the instance
      // label is a UUID and useless to read.
      name: txt.fn || instance.replace(`.${CAST_SERVICE}`, ''),
      model: txt.md || undefined,
      address,
      port: srv?.data?.port || 8009,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Sockets and HTTP — the part that needs a LAN.
// ---------------------------------------------------------------------------

/**
 * Every non-loopback IPv4 address this host owns.
 *
 * Multicast is sent from ONE interface, chosen by the routing table, and on
 * this host the routing table's idea of where 239.255.255.250 lives is not
 * necessarily the interface the TV is on: running with `network_mode: host`
 * means we also see docker's bridges (br-*, docker0). Sending the same search
 * out of every interface costs three extra datagrams on networks where nothing
 * answers, and is the difference between finding the TV and not.
 */
function localIPv4Addresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list || []) {
      // Node <18 reported family as a string, >=18 as a number, and both shapes
      // are in the wild depending on the base image.
      const isV4 = iface.family === 'IPv4' || iface.family === 4;
      if (!isV4 || iface.internal) continue;
      found.push(iface.address);
    }
  }
  return found;
}

/**
 * Send `packets` to a multicast group from one local address and collect what
 * comes back until `timeoutMs`.
 *
 * Never rejects: one interface refusing to join a group (common for a docker
 * bridge with no carrier) must not lose the answers another interface already
 * gave us. It does log, so an empty list can be told apart from a list that was
 * never asked for.
 */
function probeFrom(address, { port, group, packets, onMessage, timeoutMs, scope }) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      logError(`${scope}.socket`, err, { via: address });
      resolve();
      return;
    }

    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(retry);
      try {
        socket.close();
      } catch {
        // Already closed by the error path; nothing to do and nothing to say.
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    let retry;

    socket.on('error', (err) => {
      logError(`${scope}.socket`, err, { via: address });
      finish();
    });
    socket.on('message', (buf, rinfo) => {
      try {
        onMessage(buf, rinfo);
      } catch (err) {
        // One malformed answer from one device cannot end the scan for the rest.
        logError(`${scope}.parse`, err, { from: rinfo.address });
      }
    });

    const blast = () => {
      if (closed) return;
      for (const packet of packets) {
        socket.send(packet, port, group, (err) => {
          if (err) logError(`${scope}.send`, err, { via: address, group });
        });
      }
    };

    socket.bind({ address: address === '0.0.0.0' ? undefined : address, port: 0 }, () => {
      try {
        socket.setMulticastTTL(4);
        if (address !== '0.0.0.0') socket.setMulticastInterface(address);
      } catch (err) {
        // A bridge with no carrier refuses this. Keep going: the send below may
        // still work, and the other interfaces are unaffected.
        logError(`${scope}.iface`, err, { via: address });
      }
      blast();
      // UDP has no retransmission, and a single dropped datagram is a device
      // that "is not there". One repeat inside the same window is cheap.
      retry = setTimeout(blast, Math.min(500, Math.max(50, Math.floor(timeoutMs / 3))));
    });
  });
}

function mSearchPacket(searchTarget) {
  // MX is the maximum random delay a device waits before answering. It must fit
  // INSIDE the scan window or the answer arrives after we stopped listening.
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 1',
      `ST: ${searchTarget}`,
      'USER-AGENT: poisonflix-cast-bridge/1.0 UPnP/1.0',
      '',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

/**
 * Fold ONE SSDP answer into `byLocation`, or refuse it and say why.
 *
 * Exported because this is the door: every URL this service ever fetches
 * descends from a LOCATION accepted here, so "the guard is wired in" is a
 * property worth pinning with a test rather than reading off the source.
 *
 * `from` is the address the datagram was received from. Be precise about what
 * that buys, because it is less than it looks: a UDP source address IS
 * forgeable, and the M-SEARCH goes to a multicast group so anyone on the LAN
 * sees our source port and can answer with a spoofed one. What an attacker
 * cannot do is RECEIVE at an address they do not hold. So this rule does not
 * stop a spoofed answer; it stops the answer from being useful — every request
 * it can cause is aimed at the address it claimed to be, never at the attacker.
 * What survives is BLIND SSRF (port sweeps and internal GETs whose answers the
 * attacker never sees). What does not survive is exfiltration, which is the
 * property that matters while the DLNA body carries a Jellyfin api_key.
 */
export function acceptSsdpResponse(byLocation, text, from) {
  const parsed = parseSsdpResponse(text);
  if (!parsed) return { accepted: false, code: 'not-ssdp', reason: 'not an SSDP response' };
  const location = parsed.headers.location;
  // No LOCATION means no descriptor, which means no name, no model and no
  // service list. There is nothing to offer the user about such a device.
  if (!location) return { accepted: false, code: 'no-location', reason: 'no LOCATION header' };

  // The ONE address-class check in this module, done here because this is where
  // an address first enters the system and nothing downstream can forge it
  // afterwards. A television is never on loopback: a process on this host
  // answering our M-SEARCH from 127.0.0.1 with `LOCATION: http://127.0.0.1:.../`
  // is precisely the trick host networking makes possible.
  const forbidden = forbiddenAddressReason(from);
  if (forbidden) {
    return { accepted: false, code: 'forbidden-source', reason: `source address is ${forbidden}` };
  }

  const { url, reason } = sameDeviceUrl(from, location);
  if (!url) {
    return { accepted: false, code: 'cross-host', reason: `LOCATION ${reason}` };
  }

  // Keyed by the NORMALIZED href, so two spellings of one descriptor URL cannot
  // become two devices.
  const existing = byLocation.get(url);
  const entry = existing || {
    address: normalizeHost(from),
    location: url,
    server: parsed.headers.server || null,
    searchTargets: new Set(),
  };
  // A device answers once per matching ST; the union is what tells us it is
  // both a DIAL receiver and a renderer.
  if (parsed.headers.st) entry.searchTargets.add(parsed.headers.st);
  if (!entry.server && parsed.headers.server) entry.server = parsed.headers.server;
  byLocation.set(url, entry);
  return { accepted: true, code: 'ok', reason: null };
}

/** Every SSDP endpoint that answered, keyed by LOCATION. */
async function scanSsdp(timeoutMs) {
  /** @type {Map<string, { address: string, location: string, server: string|null, searchTargets: Set<string> }>} */
  const byLocation = new Map();
  const packets = SEARCH_TARGETS.map(mSearchPacket);

  const onMessage = (buf, rinfo) => {
    const { accepted, code, reason } = acceptSsdpResponse(
      byLocation,
      buf.toString('utf8'),
      rinfo.address,
    );
    // `not-ssdp` and `no-location` are the ordinary noise of an `ssdp:all`
    // search (byebye notices, devices with nothing to describe) and logging
    // them would bury the line below. A REFUSED answer is different: it is
    // either an attack or a device that will never appear in the list, and
    // both must be readable afterwards. Never silence.
    if (!accepted && code !== 'not-ssdp' && code !== 'no-location') {
      logInfo('discovery.ssdp', 'SSDP answer discarded: a device may only speak about itself', {
        from: rinfo.address,
        code,
        reason,
      });
    }
  };

  const sources = localIPv4Addresses();
  await Promise.all(
    (sources.length ? sources : ['0.0.0.0']).map((address) =>
      probeFrom(address, {
        port: SSDP_PORT,
        group: SSDP_ADDRESS,
        packets,
        onMessage,
        timeoutMs,
        scope: 'discovery.ssdp',
      }),
    ),
  );

  return [...byLocation.values()].map((entry) => ({
    ...entry,
    searchTargets: [...entry.searchTargets],
  }));
}

/** How much a discovered Chromecast record actually tells us. */
function informationScore(cast) {
  return (cast.model ? 1 : 0) + (cast.name && cast.name !== cast.address ? 1 : 0);
}

/**
 * The Chromecasts in one mDNS answer that this process is allowed to dial.
 *
 * Same rule as SSDP, same reason: the address comes from an A record inside the
 * datagram, which the sender writes, and adapters/cast.mjs opens a TLS socket to
 * whatever lands here and sends it the media URL — `api_key` and all. `from` is
 * the only address in the exchange the sender did not choose.
 */
export function acceptChromecasts(message, from) {
  const accepted = [];
  for (const cast of chromecastsFromDns(message, from)) {
    const forbidden = forbiddenAddressReason(cast.address);
    const sameHost = normalizeHost(cast.address) === normalizeHost(from);
    if (forbidden || !sameHost) {
      logInfo('discovery.mdns', 'chromecast discarded: a device may only speak about itself', {
        from,
        address: cast.address,
        reason: forbidden ? `address is ${forbidden}` : `points at ${cast.address}, not at ${from}`,
      });
      continue;
    }
    accepted.push({ ...cast, address: normalizeHost(cast.address) });
  }
  return accepted;
}

/** Chromecasts that answered the `_googlecast._tcp` PTR question. */
async function scanMdns(timeoutMs) {
  const byAddress = new Map();
  const queryId = Math.floor(Math.random() * 0xffff);
  const packets = [buildMdnsQuery(CAST_SERVICE, { id: queryId })];

  const onMessage = (buf, rinfo) => {
    const message = parseDnsMessage(buf);
    // Responses only. Our own query is echoed back to us on interfaces where
    // multicast loops, and parsing it as an answer would list nothing anyway —
    // but skipping it keeps the logs honest about what the LAN said.
    if ((message.flags & 0x8000) === 0) return;
    for (const cast of acceptChromecasts(message, rinfo.address)) {
      const existing = byAddress.get(cast.address);
      // Answers arrive in pieces: one datagram may carry only the SRV, the next
      // the TXT that holds the name the owner typed. Keep whichever says MORE,
      // rather than whichever happened to arrive first — the previous version
      // compared only the model, so a bare record could keep the friendly name
      // out of the list forever.
      if (!existing || informationScore(cast) > informationScore(existing)) {
        byAddress.set(cast.address, cast);
      }
    }
  };

  const sources = localIPv4Addresses();
  await Promise.all(
    (sources.length ? sources : ['0.0.0.0']).map((address) =>
      probeFrom(address, {
        port: MDNS_PORT,
        group: MDNS_ADDRESS,
        packets,
        onMessage,
        timeoutMs,
        scope: 'discovery.mdns',
      }),
    ),
  );

  return [...byAddress.values()];
}

/** Body as text, refusing anything that is clearly not a descriptor. */
async function readCappedText(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The descriptor at `location`, which must belong to `address`.
 *
 * Exported for the tests: this is the actual `fetch` sink, and a guard that
 * only exists in the pure helpers is a guard nothing proves is called.
 */
export async function fetchDescriptor(location, address) {
  // Belt to `acceptSsdpResponse`'s braces. Its LOCATION was already checked
  // against the datagram's source, so this can only fire if a future caller
  // reaches this function some other way — which is exactly when a guard that
  // lives only at the door stops helping.
  const safe = sameDeviceUrl(address, location);
  if (!safe.url) {
    logInfo('discovery.descriptor', 'descriptor refused: a device may only speak about itself', {
      address,
      location,
      reason: safe.reason,
    });
    return { descriptor: null, applicationUrl: null, error: `refused: ${safe.reason}` };
  }

  try {
    const res = await fetch(safe.url, {
      signal: AbortSignal.timeout(DESCRIPTOR_TIMEOUT_MS),
      headers: { accept: 'text/xml, application/xml, */*' },
      // Without this the same-host check above is theatre: `follow` is fetch's
      // default, so a device could answer this exact request with
      // `302 Location: http://127.0.0.1:8096/` and be fetched there anyway. The
      // guard runs on the URL we send, and only refusing redirects keeps that
      // the URL that is actually dialed.
      redirect: 'error',
    });
    // DIAL publishes where its apps live in a RESPONSE HEADER of the descriptor
    // fetch, not inside the XML — the Samsung answers
    // `Application-URL: http://192.168.1.28:8080/ws/app/` here.
    //
    // Which makes it a URL the device chooses and `probeDialApp` then fetches,
    // so it gets the same treatment as everything else the device says: it may
    // only point back at the device. Dropped rather than fatal — a set with a
    // hostile header is still a usable DLNA renderer or webOS target.
    const applicationUrl = acceptApplicationUrl(
      res.headers.get('application-url'),
      address,
      safe.url,
    );
    if (!res.ok) {
      // Same reason as in probeDialApp: drop the body deliberately rather than
      // leave a connection hanging on every device that answered an error.
      res.body?.cancel().catch(() => {});
      return { descriptor: null, applicationUrl, error: `HTTP ${res.status}` };
    }
    const xml = await readCappedText(res, MAX_DESCRIPTOR_BYTES);
    return { descriptor: parseDescriptor(xml), applicationUrl, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError('discovery.descriptor', err, { location });
    return { descriptor: null, applicationUrl: null, error };
  }
}

/** The `Application-URL` header, but only when it points back at the device. */
function acceptApplicationUrl(header, address, location) {
  if (!header) return null;
  const { url, reason } = sameDeviceUrl(address, header, location);
  if (!url) {
    logInfo('discovery.dial', 'Application-URL discarded: a device may only speak about itself', {
      address,
      location,
      applicationUrl: header,
      reason,
    });
    return null;
  }
  return url;
}

async function probeDialApp(applicationUrl) {
  const target = appResourceUrl(applicationUrl, DIAL_APP);
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(DESCRIPTOR_TIMEOUT_MS),
      headers: { accept: 'text/xml, */*' },
      // Same reason as fetchDescriptor: the Application-URL was checked to
      // belong to the device, and a followed redirect would make that check
      // describe a request that never happened.
      redirect: 'error',
    });
    // The STATUS is the entire answer — 200 installed, 404 not — so the body is
    // dropped. Explicitly, though: an unconsumed response body keeps the
    // connection open until garbage collection, and this runs against every
    // DIAL device on the LAN on every scan.
    res.body?.cancel().catch(() => {});
    return { status: res.status };
  } catch (err) {
    logError('discovery.dial', err, { target });
    return { status: null };
  }
}

/**
 * One full scan: SSDP + mDNS in parallel, then the HTTP follow-ups.
 *
 * Returns INTERNAL device records (they carry `endpoint`, which the adapters
 * need and the API must not leak) — see `toPublicDevice`.
 */
export async function scanDevices(timeoutMs = SCAN_TIMEOUT_MS) {
  const started = Date.now();
  const [ssdpEndpoints, chromecasts] = await Promise.all([
    scanSsdp(timeoutMs).catch((err) => {
      logError('discovery.ssdp', err, {});
      return [];
    }),
    scanMdns(timeoutMs).catch((err) => {
      logError('discovery.mdns', err, {});
      return [];
    }),
  ]);

  const endpoints = await Promise.all(
    ssdpEndpoints.map(async (endpoint) => {
      const { descriptor, applicationUrl, error } = await fetchDescriptor(
        endpoint.location,
        endpoint.address,
      );
      const dialProbe = applicationUrl ? await probeDialApp(applicationUrl) : null;
      return { ...endpoint, descriptor, applicationUrl, descriptorError: error, dialProbe };
    }),
  );

  const devices = buildDevices({ endpoints, chromecasts });
  // The one line that answers "did it even look?" when the list is empty — a
  // scan that found nothing and a scan that never ran read identically from the
  // player screen.
  logInfo('discovery.scan', 'scan finished', {
    ms: Date.now() - started,
    ssdpEndpoints: ssdpEndpoints.length,
    chromecasts: chromecasts.length,
    devices: devices.length,
    usable: devices.filter((d) => d.capability !== 'none').length,
  });
  return devices;
}
