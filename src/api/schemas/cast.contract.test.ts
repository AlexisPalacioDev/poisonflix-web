import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CastDevicesResponseSchema,
  CastErrorBodySchema,
  CastPlayResponseSchema,
  CastStopResponseSchema,
} from './cast';
import { castFailureReason, playOnDevice, stopDevice } from '../cast';

// Contract test against the bodies `infra/cast-bridge` actually emits.
//
// The schema for `/play` declared `{ ok, needsPairing? }` and nothing else, and
// zod STRIPS what a schema does not declare. Every adapter's `reason` — the one
// sentence that says what the television did and what to do about it — was
// therefore deleted at the parse, and the sheet showed the same generic
// "rechazó la reproducción. Probá de nuevo." for a missing app, a launcher that
// answered 403, and a video that arrived but never started.
//
// Nothing caught it because the component test mocks `playOnDevice` wholesale:
// it asserts the payload sent, never a response parsed. So this file works from
// the bridge's own source instead of from fixtures written to match the schema,
// and it exercises the REAL `apiFetch` path the browser takes.

const BRIDGE = path.resolve(process.cwd(), 'infra/cast-bridge');
const ADAPTERS = path.join(BRIDGE, 'adapters');

/**
 * Blanks the CONTENT of every string and template literal, keeping the source's
 * length and structure. Brace matching and key extraction below both run on the
 * result: without this, a reason like "La app no está corriendo en la TV
 * (estado: …)" reads as a key named `estado`, and a template's `${}` reads as
 * an object literal.
 */
function maskLiterals(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        out[j] = ' ';
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') {
        out[j] = ' ';
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      let j = i;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) {
        out[j] = ' ';
        j += 1;
      }
      i = j + 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Extent of the balanced `open`/`close` block that starts at `from`. */
function blockAt(masked: string, from: number, open = '{', close = '}'): string {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return masked.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced ${open}${close} from offset ${from}`);
}

/**
 * Every `return { ok: … }` inside the adapter's EXPORTED `play` and `stop`,
 * as masked source text — the bodies the bridge forwards to the browser.
 *
 * Scoped to those two functions on purpose: the adapters also pass `{ ok, … }`
 * around internally (an ssap socket request answers `{ ok, error }`, a Chromecast
 * frame `{ ok, payload, status }`) and those never leave the bridge. Folding
 * them in would make this assert a vocabulary the frontend is not supposed to
 * know, which is a different and much weaker claim.
 */
function responseLiterals(source: string): string[] {
  const masked = maskLiterals(source);
  const found: string[] = [];
  const entry = /export\s+async\s+function\s+(play|stop)\s*\(/g;
  let fn = entry.exec(masked);
  while (fn) {
    // Past the parameter list before looking for the body. `play(device, {
    // appUrl, title })` destructures, so the first `{` after the name is the
    // parameter pattern - taking it as the body silently found no returns at
    // all in three of the four adapters, and the count guard below is what
    // caught that.
    const params = blockAt(masked, masked.indexOf('(', fn.index), '(', ')');
    const bodyStart = masked.indexOf('(', fn.index) + params.length;
    const body = blockAt(masked, masked.indexOf('{', bodyStart));
    const opener = /return\s*(\{\s*ok\s*:)/g;
    let match = opener.exec(body);
    while (match) {
      const literal = blockAt(body, match.index + match[0].length - match[1].length);
      found.push(literal);
      opener.lastIndex = match.index + match[0].length;
      match = opener.exec(body);
    }
    fn = entry.exec(masked);
  }
  return found;
}

/** Every property name appearing anywhere inside a response literal, nested
 *  ones included — `...(result?.needsPairing ? { needsPairing: true } : {})` is
 *  how the bridge builds half of its envelope. */
function keysIn(literal: string): string[] {
  return [...literal.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
}

function adapterSources(): Array<{ file: string; source: string }> {
  const files = readdirSync(ADAPTERS).filter((f) => f.endsWith('.mjs') && !f.includes('.test.'));
  if (files.length === 0) throw new Error(`no adapters found in ${ADAPTERS}`);
  return files.map((file) => ({ file, source: readFileSync(path.join(ADAPTERS, file), 'utf8') }));
}

/**
 * The bodies `runAction` in `cast-bridge/server.mjs` sends, by HTTP status.
 *
 * This — not the adapter's return value — is what the browser receives. The
 * adapters answer `runAction`, and `runAction` REPROJECTS that answer into its
 * own literal before writing it to the socket, so a key an adapter invents
 * never leaves the bridge, and a key added here reaches the browser without
 * passing through any adapter at all. Scraping only the adapters would leave
 * the second case invisible, which is the same blind spot that lost `reason`
 * in the first place, one layer up.
 *
 * The BFF in between is a byte-for-byte forward (`infra/bff/cast.mjs`), so this
 * is the last place the shape is decided.
 */
function bridgeSentBodies(): Array<{ status: number; text: string }> {
  const masked = maskLiterals(readFileSync(path.join(BRIDGE, 'server.mjs'), 'utf8'));
  const fn = /async\s+function\s+runAction\s*\(/.exec(masked);
  if (!fn) throw new Error('could not find `runAction` in cast-bridge/server.mjs');
  const params = blockAt(masked, masked.indexOf('(', fn.index), '(', ')');
  const body = blockAt(masked, masked.indexOf('{', masked.indexOf('(', fn.index) + params.length));

  const sent: Array<{ status: number; text: string }> = [];
  const call = /send\(\s*res\s*,\s*(\d{3})\s*,\s*\{/g;
  let match = call.exec(body);
  while (match) {
    const open = match.index + match[0].length - 1;
    sent.push({ status: Number(match[1]), text: blockAt(body, open) });
    call.lastIndex = open + 1;
    match = call.exec(body);
  }
  if (sent.length === 0) throw new Error('`runAction` sent no bodies — the scraper is broken');
  return sent;
}

describe('cast /play and /stop: what the bridge sends vs what the schema keeps', () => {
  const sources = adapterSources();
  const perAdapter = sources.map(({ file, source }) => ({ file, literals: responseLiterals(source) }));
  const literals = perAdapter.flatMap(({ file, literals: ls }) => ls.map((text) => ({ file, text })));

  it('found each adapter’s response literals', () => {
    // A scraper that silently matched nothing would make every assertion below
    // pass by comparing an empty set — the failure mode this guard exists for,
    // and it earned its keep: an earlier version mistook `play(device, {
    // appUrl, title })`'s destructuring for the function body and found zero
    // returns in three of the four adapters.
    //
    // Counted PER ADAPTER rather than as one total, and against a floor rather
    // than an exact number. A single total lets one adapter go silent while the
    // other three cover for it, and an exact number goes stale the first time
    // someone adds a failure path (it already did, mid-review).
    expect(perAdapter.map(({ file }) => file).sort()).toEqual(
      ['cast.mjs', 'dial.mjs', 'dlna.mjs', 'ssap.mjs'],
    );
    for (const { file, literals: ls } of perAdapter) {
      expect(ls.length, `${file} returns almost nothing — is the scraper still matching?`).toBeGreaterThan(7);
    }
  });

  it('speaks exactly the vocabulary the bridge forwards to the browser', () => {
    const fromAdapters = new Set(literals.flatMap(({ text }) => keysIn(text)));
    // `runAction`'s last statement is the reprojection every successful call
    // goes through: `{ ok, ...(needsPairing), ...(reason) }`. Comparing the two
    // sides against each other (rather than against a list written here) is
    // what makes this a contract test: a key added on either side without the
    // other fails, and the failure says which side moved.
    const forwarded = bridgeSentBodies().filter(({ status }) => status === 200).pop();
    expect(forwarded, 'runAction sends no 200 — the scraper is broken').toBeDefined();
    const fromBridge = new Set(keysIn(forwarded?.text ?? ''));

    expect([...fromAdapters].sort()).toEqual([...fromBridge].sort());

    // …and the schema must KEEP every one of them, not merely tolerate them.
    const everything = { ok: false, needsPairing: true, reason: 'La TV no aceptó el emparejamiento.' };
    expect(Object.keys(CastPlayResponseSchema.parse(everything)).sort()).toEqual([...fromBridge].sort());
    expect(Object.keys(CastStopResponseSchema.parse(everything)).sort()).toEqual([...fromBridge].sort());
  });

  it('declares every key the bridge puts in a failure it sends as an error status', () => {
    // 400 "Falta el dispositivo.", 404 "Ese dispositivo ya no aparece en la
    // red.", 500 "no se puede manejar desde acá." — these never reach the
    // response schemas at all, because `apiFetch` throws them.
    const errors = bridgeSentBodies().filter(({ status }) => status !== 200);
    expect(errors.length).toBeGreaterThan(2);
    const emitted = new Set(errors.flatMap(({ text }) => keysIn(text)));
    expect([...emitted].sort()).toEqual(['error', 'ok', 'reason']);
    // `ok` is the one the extraction deliberately ignores: on a thrown status
    // it is always false and says nothing the status did not already say.
    expect(Object.keys(CastErrorBodySchema.parse({ ok: false, error: 'x', reason: 'y' })).sort()).toEqual([
      'error',
      'reason',
    ]);
  });

  it('carries a reason on the failure paths, which is what makes them worth parsing', () => {
    for (const { file, literals: ls } of perAdapter) {
      const withReason = ls.filter((text) => keysIn(text).includes('reason'));
      // Per adapter again: if ONE of them stops explaining itself, every
      // failure it can produce turns into the same generic line, and a total
      // across four files would barely move.
      expect(withReason.length, `${file} explains almost none of its failures`).toBeGreaterThan(5);
    }
    // Every failure the bridge itself decides carries one too.
    for (const { status, text } of bridgeSentBodies()) {
      if (keysIn(text).includes('ok') && !/ok\s*:\s*true/.test(text)) {
        expect(keysIn(text), `the ${status} body says nothing`).toContain('reason');
      }
    }
  });
});

// The bodies below are copied verbatim from the bridge, with the line they came
// from. They are the payloads the browser receives, not fixtures written to fit.
describe('cast responses copied from the bridge, parsed', () => {
  it('keeps the launcher failure sentence (ssap.mjs:616)', () => {
    const parsed = CastPlayResponseSchema.parse({
      ok: false,
      reason: 'La TV no pudo abrir la página (403).',
    });
    expect(parsed.reason).toBe('La TV no pudo abrir la página (403).');
  });

  it('keeps the missing-app sentence (dial.mjs:113-117)', () => {
    const parsed = CastPlayResponseSchema.parse({
      ok: false,
      reason:
        'La TV ya no tiene la app PoisonFlix instalada. Instalala desde su tienda y volvé a escanear.',
    });
    expect(parsed.reason).toContain('Instalala desde su tienda');
  });

  it('keeps the loaded-but-never-started sentence (dlna.mjs:118-125)', () => {
    const parsed = CastPlayResponseSchema.parse({
      ok: false,
      reason: 'El video llegó al dispositivo pero no arrancó (701 Transition not available).',
    });
    expect(parsed.reason).toContain('pero no arrancó');
  });

  it('keeps pairing AND its sentence together (ssap.mjs:599-604)', () => {
    const parsed = CastPlayResponseSchema.parse({
      ok: false,
      needsPairing: true,
      reason: 'La TV está pidiendo permiso en pantalla. Aceptalo con el control y volvé a darle play.',
    });
    expect(parsed.needsPairing).toBe(true);
    expect(parsed.reason).toContain('Aceptalo con el control');
  });

  it('keeps the bare success envelope every adapter returns (dial.mjs:111)', () => {
    const parsed = CastPlayResponseSchema.parse({ ok: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBeUndefined();
  });

  // `/stop` is not the poorer relative: it fails in as many ways, and the LG
  // adapter can even answer `needsPairing` there (ssap.mjs:639-645).
  it('keeps a stop refusal (cast.mjs:505)', () => {
    const parsed = CastStopResponseSchema.parse({
      ok: false,
      reason: 'El Chromecast no está reproduciendo nada de PoisonFlix.',
    });
    expect(parsed.reason).toBe('El Chromecast no está reproduciendo nada de PoisonFlix.');
  });

  it('keeps pairing on a stop, which is easy to think of as play-only (ssap.mjs:639-645)', () => {
    const parsed = CastStopResponseSchema.parse({
      ok: false,
      needsPairing: true,
      reason: 'La TV no aceptó la conexión, así que no se pudo cerrar nada.',
    });
    expect(parsed.needsPairing).toBe(true);
    expect(parsed.reason).toContain('no se pudo cerrar nada');
  });

  it('keeps a discovered device that is unusable, with its reason (discovery.mjs:155)', () => {
    const parsed = CastDevicesResponseSchema.parse({
      devices: [
        {
          id: 'dial:192.168.1.31',
          name: 'Samsung del cuarto',
          address: '192.168.1.31',
          protocol: 'dial',
          capability: 'none',
          reason:
            'Esta TV no tiene la app PoisonFlix instalada. Instalala desde la tienda de la TV y volvé a escanear.',
        },
      ],
    });
    expect(parsed.devices[0]?.reason).toContain('Instalala desde la tienda');
  });

  it('lands a bridge-less deployment on an empty list, not a parse error (bff/cast.mjs:176)', () => {
    expect(CastDevicesResponseSchema.parse({ devices: [] }).devices).toEqual([]);
  });
});

// The bridge reserves real status codes for the REQUEST being wrong, and those
// bodies carry the same actionable sentence — but `apiFetch` raises them as a
// thrown `ApiError`, so the sentence only survives if someone reads it back.
describe('cast failures that arrive as a thrown status', () => {
  it('reads the sentence out of a 404 body (cast-bridge/server.mjs:200-204)', () => {
    const body = {
      ok: false,
      error: 'unknown_device',
      reason: 'Ese dispositivo ya no aparece en la red. Volvé a escanear.',
    };
    expect(CastErrorBodySchema.parse(body).reason).toBe(
      'Ese dispositivo ya no aparece en la red. Volvé a escanear.',
    );
  });

  it('reads the sentence out of a 400 body (cast-bridge/server.mjs:195)', () => {
    const body = { ok: false, error: 'bad_request', reason: 'Falta el dispositivo.' };
    expect(CastErrorBodySchema.parse(body).reason).toBe('Falta el dispositivo.');
  });

  // The BFF's own failures explain nothing to a user and carry no `ok` at all
  // (bff/cast.mjs:250,313). They must parse cleanly and simply yield nothing,
  // so the caller falls back to its own copy instead of the extraction throwing.
  it('accepts the BFF-level bodies that carry no reason', () => {
    expect(CastErrorBodySchema.parse({ error: 'cast_bridge_unreachable' }).reason).toBeUndefined();
    expect(CastErrorBodySchema.parse({ error: 'cast_bridge_unconfigured' }).reason).toBeUndefined();
    expect(CastErrorBodySchema.parse({ error: 'internal' }).reason).toBeUndefined();
  });
});

// Everything above validates shapes in isolation. This last block drives the
// REAL client — `apiFetch`, the real URL, the real schema — because the gap the
// bug slipped through is precisely that no test ever did.
describe('the client the browser actually runs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('posts to /bff/cast/play and hands back the bridge’s reason', async () => {
    const fetchMock = stubFetch({ ok: false, reason: 'La TV no pudo abrir la página (403).' });

    const response = await playOnDevice({
      deviceId: 'ssap:192.168.1.20',
      appUrl: 'http://192.168.1.50:8600/player/item-1?autoplay=1',
      mediaUrl: 'http://192.168.1.50:8600/jellyfin/Videos/item-1/stream.mkv',
      title: 'Duna',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/bff/cast/play');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    // The assertion the whole file exists for: it survived the parse.
    expect(response.reason).toBe('La TV no pudo abrir la página (403).');
  });

  it('posts to /bff/cast/stop and hands back its reason too', async () => {
    const fetchMock = stubFetch({
      ok: false,
      reason: 'El Chromecast no está reproduciendo nada de PoisonFlix.',
    });

    const response = await stopDevice('cast:192.168.1.40');

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe('/bff/cast/stop');
    expect(response.ok).toBe(false);
    expect(response.reason).toBe('El Chromecast no está reproduciendo nada de PoisonFlix.');
  });

  it('recovers the reason from a 404, where advice about the network is wrong', async () => {
    stubFetch(
      {
        ok: false,
        error: 'unknown_device',
        reason: 'Ese dispositivo ya no aparece en la red. Volvé a escanear.',
      },
      404,
    );

    const error = await playOnDevice({
      deviceId: 'ssap:192.168.1.20',
      appUrl: 'http://192.168.1.50:8600/player/item-1?autoplay=1',
      mediaUrl: 'http://192.168.1.50:8600/jellyfin/Videos/item-1/stream.mkv',
      title: 'Duna',
    }).catch((thrown: unknown) => thrown);

    expect(castFailureReason(error)).toBe('Ese dispositivo ya no aparece en la red. Volvé a escanear.');
  });

  it('has nothing to say about a BFF that could not reach the bridge', async () => {
    stubFetch({ error: 'cast_bridge_unreachable' }, 502);

    const error = await stopDevice('cast:192.168.1.40').catch((thrown: unknown) => thrown);

    // Not an empty string: `null` is what lets the caller name the device and
    // the action in its own fallback copy.
    expect(castFailureReason(error)).toBeNull();
  });

  it('says nothing for a failure that never reached the server', () => {
    expect(castFailureReason(new TypeError('Failed to fetch'))).toBeNull();
  });
});
