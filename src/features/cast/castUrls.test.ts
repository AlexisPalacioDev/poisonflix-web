import { describe, expect, it } from 'vitest';
import { CAST_TOKEN_PARAM, buildCastUrls, isUnreachableFromTv, streamUrlOf } from './castUrls';

// The whole feature rests on these two strings being openable from a device
// that is NOT this browser. Everything else in the cast flow can be retried;
// a wrong URL here is a television that sits silent while the app says it
// worked.

const LAN_ORIGIN = 'http://192.168.1.50:8600';
const STREAM = '/jellyfin/Videos/item-1/stream.mkv?static=true&mediaSourceId=ms-1&api_key=tok';
const TOKEN = 'tok';

function urlsOf(result: ReturnType<typeof buildCastUrls>) {
  if (result.kind !== 'ready') throw new Error(`expected usable URLs, got: ${result.reason}`);
  return result.urls;
}

describe('buildCastUrls', () => {
  it('turns the relative stream path into an absolute URL on the page origin', () => {
    const { mediaUrl } = urlsOf(buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: STREAM, token: TOKEN }));

    expect(mediaUrl).toBe(`${LAN_ORIGIN}${STREAM}`);
  });

  // The token rides in the query string precisely so the TV needs no session
  // of its own - losing it would produce a 401 nobody can see.
  it('keeps the api_key the TV needs to fetch the bytes', () => {
    const { mediaUrl } = urlsOf(buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: STREAM, token: TOKEN }));

    expect(new URL(mediaUrl).searchParams.get('api_key')).toBe('tok');
  });

  // The bug this whole route exists for: `/player/:id` is behind `RouteGuard`,
  // and a television has none of the localStorage a session lives in, so it
  // landed on the login screen while the app said "Reproduciendo en …".
  it('points the app URL at the PUBLIC cast route, never at the guarded player', () => {
    const { appUrl } = urlsOf(buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: STREAM, token: TOKEN }));

    expect(new URL(appUrl).pathname).toBe('/cast/item-1');
    expect(appUrl).not.toContain('/player/');
  });

  // Without it the television reaches the page and then 401s on every call,
  // which looks exactly like the guarded-route bug it replaced.
  it('carries the token the TV has no other way to obtain, plus autoplay', () => {
    const { appUrl } = urlsOf(buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: STREAM, token: TOKEN }));

    const params = new URL(appUrl).searchParams;
    expect(params.get(CAST_TOKEN_PARAM)).toBe(TOKEN);
    expect(params.get('autoplay')).toBe('1');
  });

  it('escapes a token whose characters would otherwise break out of the query string', () => {
    const { appUrl } = urlsOf(
      buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: STREAM, token: 'a&b=c d' }),
    );

    expect(new URL(appUrl).searchParams.get(CAST_TOKEN_PARAM)).toBe('a&b=c d');
  });

  // Requirement: a device that speaks `capability: 'app'` cannot work without
  // a token, so the honest answer is a reason - not a URL that 401s on arrival
  // while the app reports success.
  it.each(['', '   '])('refuses to cast with token %o instead of sending a URL that will 401', (token) => {
    const result = buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: STREAM, token });

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toContain('credencial');
  });

  it('escapes an item id that would otherwise change the path', () => {
    const { appUrl } = urlsOf(buildCastUrls({ origin: LAN_ORIGIN, itemId: 'a/b c', streamUrl: STREAM, token: TOKEN }));

    expect(new URL(appUrl).pathname).toBe('/cast/a%2Fb%20c');
  });

  it('leaves an already-absolute stream URL alone', () => {
    const absolute = 'http://192.168.1.50:8096/Videos/item-1/stream.mkv?api_key=tok';
    const { mediaUrl } = urlsOf(
      buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: absolute, token: TOKEN }),
    );

    expect(mediaUrl).toBe(absolute);
  });

  it('keeps https when the page is served over https', () => {
    const { appUrl, mediaUrl } = urlsOf(
      buildCastUrls({ origin: 'https://pf.example.net', itemId: 'item-1', streamUrl: STREAM, token: TOKEN }),
    );

    expect(appUrl.startsWith('https://pf.example.net/')).toBe(true);
    expect(mediaUrl.startsWith('https://pf.example.net/')).toBe(true);
  });

  // A developer on localhost cannot cast. Saying so is the feature; returning
  // a URL the TV will silently ignore is the bug this whole module exists for.
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'http://pf.localhost:5173'])(
    'refuses %s instead of handing the TV an address that means itself',
    (origin) => {
      const result = buildCastUrls({ origin, itemId: 'item-1', streamUrl: STREAM, token: TOKEN });

      expect(result.kind).toBe('unavailable');
      if (result.kind !== 'unavailable') return;
      // The reason has to say what to do next, not just that something failed.
      expect(result.reason).toContain('localhost');
      expect(result.reason).toContain('IP del servidor');
    },
  );

  // The nastiest case: the page is reachable, the video is not, and only half
  // the cast is broken.
  it('refuses a loopback stream URL even when the page origin is fine', () => {
    const result = buildCastUrls({
      origin: LAN_ORIGIN,
      itemId: 'item-1',
      streamUrl: 'http://localhost:8096/Videos/item-1/stream.mkv?api_key=tok',
      token: TOKEN,
    });

    expect(result.kind).toBe('unavailable');
  });

  it('refuses an origin that is not http(s)', () => {
    const result = buildCastUrls({ origin: 'file:///app', itemId: 'item-1', streamUrl: STREAM, token: TOKEN });

    expect(result.kind).toBe('unavailable');
  });

  it('refuses an unparseable origin instead of throwing at the call site', () => {
    const result = buildCastUrls({ origin: 'not-a-url', itemId: 'item-1', streamUrl: STREAM, token: TOKEN });

    expect(result).toEqual({ kind: 'unavailable', reason: expect.stringContaining('No se pudo armar') });
  });

  it('refuses when there is no item to send', () => {
    const result = buildCastUrls({ origin: LAN_ORIGIN, itemId: '', streamUrl: STREAM, token: TOKEN });

    expect(result.kind).toBe('unavailable');
  });

  it('refuses when the player has no source resolved yet, and says so', () => {
    const result = buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: '', token: TOKEN });

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    // Its own sentence, not the malformed-origin one: nothing is wrong with
    // the page, the video simply has not resolved yet.
    expect(result.reason).toContain('Todavía no hay un video resuelto');
  });

  // `new URL(' ', origin)` resolves to the origin's ROOT. Left unchecked, the
  // television would be handed the SPA's own HTML page as if it were a video.
  it('refuses a blank stream URL instead of sending the app itself as the video', () => {
    const result = buildCastUrls({ origin: LAN_ORIGIN, itemId: 'item-1', streamUrl: '   ', token: TOKEN });

    expect(result.kind).toBe('unavailable');
  });
});

describe('isUnreachableFromTv', () => {
  it('covers the whole 127/8 block, not just 127.0.0.1', () => {
    expect(isUnreachableFromTv('127.1.2.3')).toBe(true);
  });

  it('treats 0.0.0.0 as a bind address, never a destination', () => {
    expect(isUnreachableFromTv('0.0.0.0')).toBe(true);
  });

  // `http://[::ffff:127.0.0.1]/` comes back from the URL parser as
  // `[::ffff:7f00:1]`, which no dotted-quad check would ever recognise.
  it('sees loopback through an IPv4-mapped IPv6 literal, in either spelling', () => {
    expect(isUnreachableFromTv('[::ffff:7f00:1]')).toBe(true);
    expect(isUnreachableFromTv('[::ffff:127.0.0.1]')).toBe(true);
    expect(new URL('http://[::ffff:127.0.0.1]:5173/').hostname).toBe('[::ffff:7f00:1]');
  });

  // A trailing dot is the explicit DNS root: it resolves exactly like the name
  // without it, so it must be read the same way.
  it('sees through a fully-qualified trailing dot', () => {
    expect(isUnreachableFromTv('localhost.')).toBe(true);
  });

  // The address a machine gives itself when DHCP fails. Routable from nowhere.
  it('rejects the 169.254 link-local range', () => {
    expect(isUnreachableFromTv('169.254.1.5')).toBe(true);
  });

  it('lets real LAN and public hosts through', () => {
    expect(isUnreachableFromTv('192.168.1.50')).toBe(false);
    expect(isUnreachableFromTv('10.0.0.4')).toBe(false);
    expect(isUnreachableFromTv('pf.example.net')).toBe(false);
    // Not a loopback address: it only starts with the same three digits.
    expect(isUnreachableFromTv('127.example.net')).toBe(false);
  });
});

describe('streamUrlOf', () => {
  it('reads a DirectPlay source', () => {
    expect(streamUrlOf({ kind: 'DirectPlay', url: STREAM })).toBe(STREAM);
  });

  // A transcoded session is an HLS playlist. It still goes to the bridge:
  // which renderers accept it is the adapter's decision per protocol, not
  // something to pre-empt here by sending nothing at all.
  it('reads a transcoded source rather than giving up on casting it', () => {
    expect(streamUrlOf({ kind: 'Transcoded', hlsUrl: '/jellyfin/videos/1/master.m3u8' })).toBe(
      '/jellyfin/videos/1/master.m3u8',
    );
  });
});
