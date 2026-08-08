import { SubtitleDeliveryMethodSchema } from '../../api/schemas/jellyfin';
import type { JellyfinMediaSource, JellyfinPlaybackInfoResponse, SubtitleDeliveryMethod } from '../../api/schemas/jellyfin';

// Stream resolution + DirectPlay `<video>` auth, ported from `StreamResolver.kt`
// (design.md §3.3, §10; player spec). MVP scope only: DirectPlay via the
// `api_key` query-string (the primary live-validation target - see Slice 2's
// SPIKE VERDICT in apply-progress.md) plus an explicit not-supported marker
// for `TranscodingUrl` (deferred hls.js playback per the player spec's
// Deferred section - callers must render "not supported in this version" and
// must NOT attempt playback for a `Transcoded` result).
//
// Audio/subtitle track enumeration, resume back-off, and title/duration
// fields from the Kotlin reference's broader `ResolvedPlayback` are
// intentionally NOT ported here - they belong to Slice 7 (player UI) and the
// deferred hls.js track-selection work, out of this slice's scope.

const DEFAULT_JELLYFIN_BASE: string = import.meta.env.VITE_JELLYFIN_BASE ?? '/jellyfin';

export type PlaybackSource = { kind: 'DirectPlay'; url: string } | { kind: 'Transcoded'; hlsUrl: string };

export interface ResolvedStream {
  source: PlaybackSource;
  mediaSourceId: string;
  playSessionId: string | null;
  /** Subtitle stream index -> `DeliveryMethod`, as Jellyfin resolved it for
   * THIS specific playback session (subtitle dedup bug fix - see
   * `SubtitleDeliveryMethod`'s doc comment in `api/schemas/jellyfin.ts`).
   * Only subtitle-typed `MediaStreams` entries with a `DeliveryMethod` are
   * included - most entries won't have one at all (only the stream the
   * server actually resolved/is delivering carries it). Empty for a
   * DirectPlay source (no transcode -> nothing ever gets burned in). */
  subtitleDeliveryMethods: Record<number, SubtitleDeliveryMethod>;
}

/**
 * Extracts the per-subtitle-stream `DeliveryMethod` map from a resolved
 * `MediaSource` (subtitle dedup bug fix). Pure + exported on its own so
 * `resolvePlayback` stays a thin composition and this one piece is
 * independently testable against a raw `MediaStreams` fixture.
 */
export function subtitleDeliveryMethodsOf(mediaSource: JellyfinMediaSource): Record<number, SubtitleDeliveryMethod> {
  const result: Record<number, SubtitleDeliveryMethod> = {};
  for (const stream of mediaSource.MediaStreams) {
    if (stream.Type !== 'Subtitle' || stream.DeliveryMethod == null) continue;
    // The wire type is a plain string so that an unrecognized value can never
    // fail the response parse (see the field's comment in
    // `api/schemas/jellyfin.ts`). This is where it narrows: anything outside
    // the known five is dropped, and the caller reads that stream as having
    // no delivery method - which is exactly how it behaved before the field
    // was modelled at all.
    const parsed = SubtitleDeliveryMethodSchema.safeParse(stream.DeliveryMethod);
    if (parsed.success) {
      result[stream.Index] = parsed.data;
    }
  }
  return result;
}

const TICKS_PER_MS = 10_000;
const TICKS_PER_SECOND = TICKS_PER_MS * 1_000;

/** Jellyfin ticks (100ns units) -> whole milliseconds. */
export function ticksToMs(ticks: number): number {
  return Math.floor(ticks / TICKS_PER_MS);
}

/**
 * Playback position in seconds -> Jellyfin ticks (100ns units). This is the
 * inverse direction from `resumePositionMs` - used by `usePlaybackHeartbeat`
 * (Slice 7) to report `PositionTicks` on `Sessions/Playing|Progress|Stopped`
 * (`JellyfinApi.kt` L102-109). Negative/non-finite input clamps to 0 rather
 * than sending a nonsensical position to the server.
 */
export function secondsToTicks(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * TICKS_PER_SECOND);
}

/**
 * Resume position in ms, ready to hand to a `<video>` seek. Per the player
 * spec ("Resume seek on ready"), no seek is applied when the tick count is
 * zero/absent - this returns `0` for that case so callers can gate on `> 0`
 * directly without re-deriving the "no resume" condition themselves.
 */
export function resumePositionMs(resumePositionTicks: number | null | undefined): number {
  if (!resumePositionTicks || resumePositionTicks <= 0) return 0;
  return ticksToMs(resumePositionTicks);
}

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

function joinUrl(base: string, path: string): string {
  // A TranscodingUrl is already relative to the Jellyfin origin; an absolute
  // URL (rare, but the Kotlin reference guards for it too) passes through
  // unchanged instead of being double-prefixed.
  if (/^https?:\/\//.test(path)) return path;
  return normalizeBase(base) + path.replace(/^\//, '');
}

/**
 * Builds the DirectPlay stream URL with the token appended as the `api_key`
 * query-string param (design.md §3.3 - `<video>` cannot send a custom
 * `X-Emby-Token` header). Shape:
 * `Videos/{itemId}/stream{container}?static=true&mediaSourceId={id}&api_key={token}`.
 */
export function buildDirectPlayUrl(
  itemId: string,
  mediaSource: Pick<JellyfinMediaSource, 'Id' | 'Container'>,
  token: string,
  base: string = DEFAULT_JELLYFIN_BASE,
): string {
  const container = mediaSource.Container ? `.${mediaSource.Container}` : '';
  const query = new URLSearchParams();
  query.set('static', 'true');
  query.set('mediaSourceId', mediaSource.Id);
  query.set('api_key', token);
  return `${normalizeBase(base)}Videos/${itemId}/stream${container}?${query.toString()}`;
}

/**
 * Builds an audio stream URL for the Música feature's `<audio>` element.
 * Mirrors the DirectPlay video builder exactly: `Audio/{itemId}/stream.m4a`
 * with `static=true` and the session token as the `api_key` query param
 * (a bare `<audio>` tag can't send an `X-Emby-Token` header). Every track we
 * download is m4a/AAC, which DirectPlays natively in every browser we target,
 * so no server transcode is needed.
 *
 * NOTE: the `Audio/{id}/universal` endpoint returns HTTP 400 for this
 * client's parameters (verified against the live Jellyfin), so we use the
 * static DirectPlay stream — the same path video uses and the one that
 * actually serves bytes. `userId` is kept for signature stability but is not
 * needed by the static stream.
 */
export function buildAudioStreamUrl(
  itemId: string,
  _userId: string,
  token: string,
  base: string = DEFAULT_JELLYFIN_BASE,
): string {
  const query = new URLSearchParams();
  query.set('static', 'true');
  query.set('api_key', token);
  return `${normalizeBase(base)}Audio/${itemId}/stream.m4a?${query.toString()}`;
}

/**
 * The single decision point (design.md §3.3, §10): no `TranscodingUrl` ->
 * DirectPlay via `api_key`; `TranscodingUrl` present -> `Transcoded`, which
 * callers MUST render as an explicit "not supported in this version" state
 * (player spec) rather than attempting playback.
 */
export function resolveStreamSource(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  token: string,
  base: string = DEFAULT_JELLYFIN_BASE,
): PlaybackSource {
  if (mediaSource.TranscodingUrl) {
    return { kind: 'Transcoded', hlsUrl: joinUrl(base, mediaSource.TranscodingUrl) };
  }
  return { kind: 'DirectPlay', url: buildDirectPlayUrl(itemId, mediaSource, token, base) };
}

/**
 * Top-level entry point: a `PlaybackInfo` response -> a resolved stream +
 * the session identifiers the playback heartbeat needs. Throws if Jellyfin
 * returned no `MediaSources` (mirrors `StreamResolverImpl.resolve`'s
 * `error(...)` on the equivalent condition) - callers must surface this as a
 * playback error, not attempt a silent fallback.
 */
export function resolvePlayback(
  itemId: string,
  playbackInfo: JellyfinPlaybackInfoResponse,
  token: string,
  base: string = DEFAULT_JELLYFIN_BASE,
): ResolvedStream {
  const mediaSource = playbackInfo.MediaSources[0];
  if (!mediaSource) {
    throw new Error(`Jellyfin returned no MediaSources for item ${itemId}`);
  }
  return {
    source: resolveStreamSource(itemId, mediaSource, token, base),
    mediaSourceId: mediaSource.Id,
    playSessionId: playbackInfo.PlaySessionId ?? null,
    subtitleDeliveryMethods: subtitleDeliveryMethodsOf(mediaSource),
  };
}
