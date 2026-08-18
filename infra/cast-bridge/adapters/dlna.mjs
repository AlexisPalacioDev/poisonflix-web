// DLNA / UPnP AVTransport — hand a renderer a video URL and tell it to play.
//
// Two SOAP calls, in this order and never merged: `SetAVTransportURI` loads the
// URL and `Play` starts it. A renderer that is told to Play before it has a URI
// answers 718 ("transition not available") and shows nothing, which is the most
// common way this protocol looks broken when it is not.
//
// The metadata block is a DIDL-Lite document embedded INSIDE an XML element, so
// it is escaped twice on the way out. It is not decoration: several renderers
// (LG's among the reports) refuse a URI with no metadata, and the ones that
// accept it show the file name where a title should be.

import { logError, logInfo } from '../log.mjs';
import { guessMimeType } from '../mime.mjs';
import { escapeXml } from '../xml.mjs';

const SERVICE_TYPE = 'urn:schemas-upnp-org:service:AVTransport:1';
const REQUEST_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/** The DIDL-Lite item a renderer shows in its "now playing". */
export function didlMetadata({ title, url }) {
  const mime = guessMimeType(url);
  const kind = mime.startsWith('audio/') ? 'object.item.audioItem' : 'object.item.videoItem';
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="-1" restricted="1">',
    `<dc:title>${escapeXml(title || 'PoisonFlix')}</dc:title>`,
    `<upnp:class>${kind}</upnp:class>`,
    `<res protocolInfo="http-get:*:${mime}:*">${escapeXml(url)}</res>`,
    '</item>',
    '</DIDL-Lite>',
  ].join('');
}

/** A full SOAP envelope for one AVTransport action. */
export function soapEnvelope(action, args) {
  const body = Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${SERVICE_TYPE}">${body}</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

/** UPnP puts its real error inside a 500 body; the status alone says nothing. */
export function parseSoapFault(xml) {
  const text = String(xml);
  const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1] || null;
  const description =
    /<errorDescription>([\s\S]*?)<\/errorDescription>/i.exec(text)?.[1]?.trim() || null;
  if (!code && !description) return null;
  return { code, description };
}

// ---------------------------------------------------------------------------
// The adapter surface
// ---------------------------------------------------------------------------

export const capability = 'media';

async function invoke(controlUrl, action, args) {
  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      // The quotes around SOAPAction are required by the UPnP spec and dropping
      // them makes renderers answer 401/412 with no explanation.
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${SERVICE_TYPE}#${action}"`,
    },
    body: soapEnvelope(action, args),
    // THE most important line in this file. `controlUrl` was checked in
    // discovery.mjs to belong to the device (a device may only speak about
    // itself), and left at fetch's default of `follow` a single 307 from the
    // television would hand that check straight back: `fetch` re-sends the
    // METHOD AND THE BODY to wherever the redirect points, and this body carries
    // a media URL with `api_key=<Jellyfin token>` in its query string. That is
    // not a stray request, it is the token leaving the LAN — and the host-match
    // check would have passed on the way in. `error` makes a redirect a failed
    // invoke, which is the honest answer: a renderer that redirects its own
    // SOAP control endpoint is not one we know how to drive.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (res.ok) return { ok: true };
  const fault = parseSoapFault(text);
  return {
    ok: false,
    status: res.status,
    fault,
    error: fault ? `${fault.code} ${fault.description || ''}`.trim() : `HTTP ${res.status}`,
  };
}

export async function play(device, { mediaUrl, title }) {
  const controlUrl = device.endpoint?.controlUrl;
  if (!controlUrl) {
    return { ok: false, reason: 'El dispositivo no publicó a qué dirección mandarle el video.' };
  }
  if (!mediaUrl) {
    return { ok: false, reason: 'No se recibió la dirección del video para reproducir.' };
  }

  try {
    const load = await invoke(controlUrl, 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: mediaUrl,
      CurrentURIMetaData: didlMetadata({ title, url: mediaUrl }),
    });
    if (!load.ok) {
      logError('dlna.seturi', load.error, { controlUrl });
      return { ok: false, reason: `El dispositivo rechazó el video (${load.error}).` };
    }

    const start = await invoke(controlUrl, 'Play', { InstanceID: 0, Speed: '1' });
    if (!start.ok) {
      logError('dlna.play', start.error, { controlUrl });
      return {
        ok: false,
        // The URI landed and the transport refused to start: the video is
        // loaded on the device and someone can press play on its own remote,
        // which is worth saying rather than reporting a flat failure.
        reason: `El video llegó al dispositivo pero no arrancó (${start.error}).`,
      };
    }
    logInfo('dlna.play', 'playback started', { address: device.address });
    return { ok: true };
  } catch (err) {
    logError('dlna.play', err, { controlUrl });
    return {
      ok: false,
      reason: 'El dispositivo no respondió. Fijate que esté encendido y en la misma red.',
    };
  }
}

export async function stop(device) {
  const controlUrl = device.endpoint?.controlUrl;
  if (!controlUrl) {
    return { ok: false, reason: 'El dispositivo no publicó a qué dirección mandarle las órdenes.' };
  }
  try {
    const result = await invoke(controlUrl, 'Stop', { InstanceID: 0 });
    if (result.ok) return { ok: true };
    logError('dlna.stop', result.error, { controlUrl });
    return { ok: false, reason: `El dispositivo rechazó el stop (${result.error}).` };
  } catch (err) {
    logError('dlna.stop', err, { controlUrl });
    return { ok: false, reason: 'El dispositivo no respondió al pedido de detener el video.' };
  }
}
