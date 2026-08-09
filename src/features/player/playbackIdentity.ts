import type { PlaybackSource } from '../../lib/domain/streamResolver';

// What makes two playbacks THE SAME playback.
//
// `VideoSurface` used to identify a playback by its full stream URL. That is
// wrong in one specific, expensive way: Jellyfin mints a brand-new
// `PlaySessionId` on every `PlaybackInfo` call and bakes it into
// `TranscodingUrl`. So re-resolving the SAME movie, from the SAME media
// source, with the SAME audio and subtitle tracks produced a URL that merely
// LOOKED different - and a different URL meant a different key, which tore
// down hls.js and reloaded the <video> from zero. That is how alt-tabbing
// away from a film used to restart it (fixed at the trigger in
// `usePlaybackInfo`; this is the same defect fixed at the mechanism).
//
// Everything else the URL carries - host, item id, `MediaSourceId`,
// `AudioStreamIndex`, `SubtitleStreamIndex`, the codec decisions - genuinely
// describes WHAT is being played, so it stays in the identity and still
// forces a reload when it changes. Only `PlaySessionId` is stripped, and
// deliberately nothing else. In particular the token (`ApiKey` on a
// transcode url, `api_key` on a DirectPlay one) is LEFT IN: a rotated token
// really does invalidate the old url and SHOULD force a fresh load.
//
// DirectPlay URLs never carried a `PlaySessionId` in the first place
// (`buildDirectPlayUrl` in streamResolver.ts sets only `static`,
// `mediaSourceId` and `api_key`), so this is a no-op on that path - the bug
// was always exclusive to transcoded playback.

const VOLATILE_PARAMS = ['playsessionid'];

/** Lets relative Jellyfin paths (`/jellyfin/...`) parse. A real absolute url
 * keeps its own origin - `joinUrl` (streamResolver.ts) passes absolute
 * `TranscodingUrl`s through untouched, so two hosts serving the same path
 * are genuinely different streams and must not collide. */
const PARSE_BASE = 'http://relative.invalid';

function withoutVolatileParams(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, PARSE_BASE);
  } catch {
    // Not a parseable URL - fall back to comparing it verbatim. Worst case
    // that is the OLD behaviour (reload on any textual change), never a
    // stale stream.
    return rawUrl;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (VOLATILE_PARAMS.includes(name.toLowerCase())) url.searchParams.delete(name);
  }
  // Sorted so the identity never depends on the order Jellyfin happens to
  // emit its query params in - same params, same identity, whatever the
  // server's serialisation does next release.
  url.searchParams.sort();
  const origin = url.origin === PARSE_BASE ? '' : url.origin;
  return `${origin}${url.pathname}${url.search}`;
}

/**
 * A stable id for "this exact playback", ignoring the transcode session it
 * happens to be running under. Two sources with the same identity are
 * interchangeable: swapping one for the other would show the viewer the same
 * thing, so there is no reason to interrupt playback to do it.
 */
export function playbackIdentity(source: PlaybackSource): string {
  const url = source.kind === 'DirectPlay' ? source.url : source.hlsUrl;
  return `${source.kind}:${withoutVolatileParams(url)}`;
}
