// DIAL — "DIscovery And Launch", the protocol behind the YouTube button on
// every smart TV remote.
//
// It is the smallest of the four: the TV publishes an `Application-URL`, and
// `<Application-URL>/<AppName>` is a REST resource. GET says whether the app is
// installed and whether it is running; POST launches it; DELETE on the running
// instance stops it. That GET is also the whole capability decision — measured
// on the Samsung on this LAN, `/YouTube` answers 200 and `/PoisonFlix` answers
// 404, which is the difference between "cast here" and "install the app first".

import { sameDeviceUrl } from '../discovery.mjs';
import { logError, logInfo } from '../log.mjs';
import { firstTag } from '../xml.mjs';

const REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/**
 * The app resource document.
 *
 * `<state>` is `running`, `stopped`, or `installable=<url>`; `<link rel="run">`
 * points at the running instance, which is the only thing DELETE accepts.
 */
export function parseAppState(xml) {
  const text = String(xml);
  // `firstTag`, not a local regex: it tolerates a namespace prefix and decodes
  // entities. A private pair of regexes here did neither, so a TV answering
  // `<dial:state>running</dial:state>` — legal, and shipped by real firmware —
  // would have made every `stop` report "estado: desconocido" while the
  // descriptor path handled the identical shape correctly.
  const link = /<(?:[\w.-]+:)?link\b[^>]*\brel=["']run["'][^>]*>/i.exec(text)?.[0] || '';
  return {
    name: firstTag(text, 'name'),
    state: firstTag(text, 'state'),
    runHref: /\bhref=["']([^"']+)["']/i.exec(link)?.[1] || null,
  };
}

/**
 * Absolute URL of the running instance.
 *
 * The trailing slash is load-bearing and is the bug this function exists to
 * prevent: `new URL('run', 'http://tv/ws/app/PoisonFlix')` resolves to
 * `http://tv/ws/app/run` — the last segment is treated as a file name, so the
 * DELETE would go to a resource that belongs to no app at all.
 */
export function instanceUrl(appResource, runHref) {
  const base = appResource.endsWith('/') ? appResource : `${appResource}/`;
  try {
    return new URL(runHref || 'run', base).href;
  } catch {
    return null;
  }
}

function appResourceUrl(applicationUrl, app) {
  return applicationUrl.endsWith('/') ? `${applicationUrl}${app}` : `${applicationUrl}/${app}`;
}

// ---------------------------------------------------------------------------
// The adapter surface
// ---------------------------------------------------------------------------

export const capability = 'app';

/**
 * Launch the app with the page URL as its launch payload.
 *
 * DIAL hands the POST body to the application verbatim and says nothing about
 * its shape, so the form-encoded `url=`/`title=` pair below is OUR convention
 * with our own TV app — a different app would ignore it and simply open its
 * home screen, which is a degraded launch and not a failure.
 */
export async function play(device, { appUrl, title }) {
  const { applicationUrl, app } = device.endpoint || {};
  if (!applicationUrl) {
    return { ok: false, reason: 'La TV no publicó la dirección donde lanzar sus apps.' };
  }
  if (!appUrl) {
    return { ok: false, reason: 'No se recibió la dirección de la app para abrir en la TV.' };
  }

  const target = appResourceUrl(applicationUrl, app);
  const body = new URLSearchParams({ url: appUrl, ...(title ? { title } : {}) }).toString();

  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      // DIAL §6.1: the payload is opaque text, and TVs are picky enough about
      // this header that `application/x-www-form-urlencoded` gets rejected by
      // some firmwares even when the body is exactly that.
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
      // `applicationUrl` was checked in discovery.mjs to belong to the device.
      // Following a redirect would re-POST this body — which carries the page
      // URL we want opened — to wherever the television pointed, and the check
      // would have passed on a request that was never the one made.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logError('dial.launch', err, { target });
    return {
      ok: false,
      reason: 'La TV no respondió al pedido de abrir la app. Fijate que esté encendida.',
    };
  }

  // 201 is the specified answer; 200 is what several firmwares actually send
  // when the app was already running and got re-focused.
  if (res.status === 201 || res.status === 200) {
    logInfo('dial.launch', 'app launched', { address: device.address, status: res.status });
    return { ok: true };
  }
  if (res.status === 404) {
    return {
      ok: false,
      reason: `La TV ya no tiene la app ${app} instalada. Instalala desde su tienda y volvé a escanear.`,
    };
  }
  logError('dial.launch', `HTTP ${res.status}`, { target });
  return { ok: false, reason: `La TV rechazó el lanzamiento (respondió ${res.status}).` };
}

export async function stop(device) {
  const { applicationUrl, app } = device.endpoint || {};
  if (!applicationUrl) {
    return { ok: false, reason: 'La TV no publicó la dirección de sus apps, así que no se puede cerrar nada.' };
  }

  const target = appResourceUrl(applicationUrl, app);
  let state;
  try {
    const res = await fetch(target, {
      headers: { accept: 'text/xml, */*' },
      // Same rule as everywhere else in this service: the URL that was checked
      // must be the URL that is dialed.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: `La TV respondió ${res.status} al consultar la app.` };
    }
    state = parseAppState(await res.text());
  } catch (err) {
    logError('dial.state', err, { target });
    return { ok: false, reason: 'La TV no respondió al consultar el estado de la app.' };
  }

  // Nothing to stop is not an error worth a 500, but it is also not `ok: true`:
  // answering ok for a stop that stopped nothing is how a UI ends up showing
  // "listo" while the video keeps playing.
  if (state.state !== 'running') {
    return { ok: false, reason: `La app no está corriendo en la TV (estado: ${state.state || 'desconocido'}).` };
  }

  // `runHref` is an attribute of an XML document the television served, so it
  // is one more URL the device chose — the same class as LOCATION and
  // <controlURL>, and it gets the same rule. Lower stakes than the DLNA control
  // URL (a DELETE with no body and no credential), but "it only leaks the fact
  // that a port is open" is still a scan of the host's own services, run by
  // whoever answered an M-SEARCH.
  const candidate = instanceUrl(target, state.runHref);
  const { url: instance, reason } = sameDeviceUrl(device.address, candidate);
  if (!instance) {
    logError('dial.stop', `instance URL refused: ${reason}`, { address: device.address, candidate });
    return { ok: false, reason: 'La TV publicó una dirección que no le pertenece para cerrar la app.' };
  }
  try {
    const res = await fetch(instance, {
      method: 'DELETE',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok || res.status === 204) return { ok: true };
    logError('dial.stop', `HTTP ${res.status}`, { instance });
    return { ok: false, reason: `La TV rechazó el cierre de la app (respondió ${res.status}).` };
  } catch (err) {
    logError('dial.stop', err, { instance });
    return { ok: false, reason: 'La TV no respondió al pedido de cerrar la app.' };
  }
}
