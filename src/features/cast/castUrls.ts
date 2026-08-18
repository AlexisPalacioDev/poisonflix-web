import type { PlaybackSource } from '../../lib/domain/streamResolver';

// The two URLs `/play` needs, resolved so that a TELEVISION can open them.
//
// Every URL this app builds for itself is same-origin and relative
// (`/jellyfin/Videos/...`, `/player/:id`), which is exactly right for the
// browser and useless for a television: the TV fetches from its own IP stack,
// where a leading `/` means nothing and `localhost` is the TV itself. So both
// URLs are resolved against the page's origin here, once, in one pure
// function — and any address the TV provably cannot reach is refused with a
// sentence the user can act on.
//
// Refusing loudly is the whole point. A developer on `http://localhost:5173`
// genuinely cannot cast, and handing the bridge `http://localhost:5173/player/x`
// would produce a television that sits there doing nothing while the app
// reports success. This codebase has scars from exactly that shape of silent
// failure; the reason string is what replaces it.
//
// The stream URL itself is already self-contained: `buildDirectPlayUrl` puts
// the Jellyfin token in the query string as `api_key`, so the TV needs no
// header, no cookie and no session of its own to fetch the bytes.

export interface CastUrls {
  /** For `capability: 'app'` devices: our own PUBLIC cast page on this origin
   *  (`/cast/:id`, `features/cast/CastScreen.tsx`), asked to start playing on
   *  arrival. Deliberately not `/player/:id`: that route is behind
   *  `RouteGuard`, and a session only ever exists in the phone's own
   *  localStorage, so a television sent there landed on the login screen while
   *  this app announced "Reproduciendo en LG del living". */
  appUrl: string;
  /** For `capability: 'media'` devices: the video stream itself. */
  mediaUrl: string;
}

/**
 * A string discriminant rather than an `ok: boolean`, and that is not a style
 * choice: this project compiles without `strictNullChecks` (tsconfig.app.json),
 * and TypeScript cannot narrow a union by a boolean literal discriminant in
 * that mode - `if (!result.ok)` narrows to the WRONG member and every access
 * to `reason` fails to compile. A string discriminant narrows correctly either
 * way.
 */
export type CastUrlsResult =
  | { kind: 'ready'; urls: CastUrls }
  | { kind: 'unavailable'; reason: string };

export interface BuildCastUrlsParams {
  /** Normally `window.location.origin`. Passed in rather than read here so
   *  this stays pure and testable against origins no test runner can fake. */
  origin: string;
  /** Jellyfin item id — becomes `/cast/:id` on the app URL. */
  itemId: string;
  /** Whatever the stream resolver produced for the source currently playing.
   *  Relative (the normal case) or absolute (when `VITE_JELLYFIN_BASE` points
   *  at a full URL); both are handled. */
  streamUrl: string;
  /**
   * The Jellyfin token the television will authenticate with, carried in the
   * app URL's query string.
   *
   * The cost is real and was accepted deliberately: the token ends up in the
   * TV browser's history. What tipped it is that the SAME token is already in
   * the query string of every video URL this app builds (`buildDirectPlayUrl`
   * puts it there as `api_key`, because a `<video>` element cannot send a
   * header), so the cast page is not a new exposure — it is the existing one,
   * with a page around it. `/cast/:id` is then built as a one-door key: no
   * navigation, no library, no account.
   */
  token: string;
}

/**
 * Marks a page as opened by a cast target, per the contract's "app URL with
 * autoplay".
 *
 * Being honest about what this does today: nothing in the app reads it. The
 * player's `<video>` already carries `autoPlay` (VideoSurface.tsx), so a page
 * opened on a television starts on its own regardless — this parameter is the
 * explicit signal that it was a cast that opened it, not the mechanism that
 * makes it play. Anything that needs to behave differently for a cast session
 * (skipping a resume prompt, hiding controls no remote can reach) has a flag
 * to read instead of having to invent one.
 */
export const CAST_AUTOPLAY_PARAM = 'autoplay';

/** Query-string parameter carrying the Jellyfin token on the app URL — read
 *  back by `CastScreen`, which has no session to read it from. */
export const CAST_TOKEN_PARAM = 'token';

/** Path prefix of the public cast route (`routes/index.tsx`). Declared here so
 *  the URL a television is handed and the route that answers it cannot drift
 *  apart silently. */
export const CAST_ROUTE_PREFIX = '/cast';

const UNREACHABLE_REASON =
  'Estás entrando a PoisonFlix por una dirección local (localhost), y la TV no puede abrirla: para la TV, "localhost" es ella misma. Abrí la app por la IP del servidor en tu red (por ejemplo http://192.168.1.50:8600) y volvé a intentar.';

const NOT_HTTP_REASON =
  'La dirección de PoisonFlix no usa http ni https, así que la TV no puede abrirla.';

const BAD_ORIGIN_REASON =
  'No se pudo armar la dirección para la TV a partir de esta página.';

const NO_ITEM_REASON =
  'No se pudo identificar el video, así que no hay nada para enviar a la TV.';

const NO_SOURCE_REASON =
  'Todavía no hay un video resuelto para enviar. Esperá a que empiece a reproducirse y volvé a intentar.';

/**
 * No token, no cast. A `capability: 'app'` television opens `/cast/:id` and
 * authenticates with nothing but what is in that URL; a `capability: 'media'`
 * one fetches a stream URL whose `api_key` came from the very same token. So
 * without one, BOTH addresses are already broken, and the only useful thing
 * left to do is say so instead of reporting "Reproduciendo en …" over a
 * television showing an error.
 */
const NO_TOKEN_REASON =
  'Tu sesión no tiene una credencial válida para la TV. Cerrá sesión, volvé a entrar y probá de nuevo.';

/**
 * An IPv4 address hiding inside an IPv4-mapped IPv6 literal. Both spellings
 * are checked because the URL parser rewrites one into the other:
 * `http://[::ffff:127.0.0.1]/` comes back as `[::ffff:7f00:1]`, which no
 * amount of dotted-quad matching would ever recognise as loopback.
 */
function mappedIpv4(host: string): string | null {
  const dotted = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  // eslint-disable-next-line no-bitwise
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Every host a television cannot usefully fetch from:
 *
 * - Loopback, i.e. anything that means "whoever is asking". The whole 127/8
 *   block, `::1`, the `.localhost` TLD RFC 6761 reserves for exactly this,
 *   and the IPv4-mapped spellings of all of them.
 * - `0.0.0.0` / `::`, which are bind addresses and never destinations.
 * - 169.254/16, the link-local range a machine assigns itself when DHCP
 *   fails. It is routable from nowhere, so a TV reaches it just as blankly.
 *
 * The `URL` parser normalises a lot of this for free (`127.1`, `2130706433`
 * and `0x7f000001` all arrive here as `127.0.0.1`), which is why this works
 * on `URL.hostname` rather than on raw user input.
 */
export function isUnreachableFromTv(hostname: string): boolean {
  const host = hostname
    // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`).
    .replace(/^\[|\]$/g, '')
    // A trailing dot is the explicit root of a fully-qualified name:
    // `localhost.` resolves exactly like `localhost`.
    .replace(/\.$/, '')
    .toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true;

  const mapped = mappedIpv4(host);
  const ipv4 = mapped ?? host;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ipv4)) return true;
  return mapped === '0.0.0.0';
}

/** The URL of whichever source is playing right now. A transcoded session is
 *  an HLS playlist: fine for a Chromecast, and something a plain DLNA renderer
 *  may well refuse — but that is the bridge's call to make per protocol, not
 *  something to decide here by withholding the URL. */
export function streamUrlOf(source: PlaybackSource): string {
  return source.kind === 'DirectPlay' ? source.url : source.hlsUrl;
}

export function buildCastUrls({ origin, itemId, streamUrl, token }: BuildCastUrlsParams): CastUrlsResult {
  if (!itemId.trim()) return { kind: 'unavailable', reason: NO_ITEM_REASON };
  // Trimmed, not just checked for emptiness: `new URL(' ', origin)` resolves
  // to the origin's ROOT, so a blank source would hand the television the
  // SPA's own HTML and call it a video.
  const source = streamUrl.trim();
  if (!source) return { kind: 'unavailable', reason: NO_SOURCE_REASON };
  // Same trim, same reason as the source above: `?token=` with nothing after
  // it is a television that reaches the page and then gets a 401 nobody sees.
  const castToken = token.trim();
  if (!castToken) return { kind: 'unavailable', reason: NO_TOKEN_REASON };

  let appUrl: URL;
  let mediaUrl: URL;
  try {
    appUrl = new URL(`${CAST_ROUTE_PREFIX}/${encodeURIComponent(itemId)}`, origin);
    mediaUrl = new URL(source, origin);
  } catch {
    return { kind: 'unavailable', reason: BAD_ORIGIN_REASON };
  }

  appUrl.searchParams.set(CAST_TOKEN_PARAM, castToken);
  appUrl.searchParams.set(CAST_AUTOPLAY_PARAM, '1');

  // BOTH URLs are checked, not just the origin. They can disagree: with
  // `VITE_JELLYFIN_BASE=http://localhost:8096` the page can be served from a
  // LAN address while the stream still points at the loopback interface, and
  // only the video would be broken on the TV — the hardest version of this
  // bug to diagnose from the couch.
  for (const url of [appUrl, mediaUrl]) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { kind: 'unavailable', reason: NOT_HTTP_REASON };
    }
    if (isUnreachableFromTv(url.hostname)) {
      return { kind: 'unavailable', reason: UNREACHABLE_REASON };
    }
  }

  return { kind: 'ready', urls: { appUrl: appUrl.toString(), mediaUrl: mediaUrl.toString() } };
}
