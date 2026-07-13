import { useQuery } from '@tanstack/react-query';
import { getItem } from '../../api/jellyfin';
import { queryKeys } from '../../hooks/queryKeys';
import { languageDisplayName } from '../../lib/domain/languageNames';

// Audio/subtitle track enumeration for the player's track menus (player spec
// §8, projector-feature-map.md §8, ← `TrackMenu.kt`'s `AudioTrack`/
// `SubtitleTrack` domain models). `api/schemas/jellyfin.ts` deliberately
// leaves `MediaStreams` as `z.array(z.unknown())` (out of this change's
// touchable-files list) - `parseMediaStreamTracks` below is this feature's
// own defensive reader of that raw shape, kept local to the player feature
// rather than widening the shared schema.
//
// `useItemMediaStreams` fetches the item a SECOND time (`usePlaybackInfo`
// already requests `Fields=...,MediaStreams,...` but discards the raw
// streams once it derives `PlaybackData`) - a deliberate, small duplication:
// `src/hooks/usePlaybackInfo.ts` is out of this change's touchable-files
// list, so extending its return shape isn't an option here. The extra
// request is scoped to `Fields=MediaStreams` only (cheap) and shares
// `queryKeys.item` in case another feature ever fetches the same key.

export type MediaStreamKind = 'Audio' | 'Subtitle';

export interface MediaStreamTrack {
  /** Jellyfin `MediaStream.Index` - doubles as the `AudioStreamIndex` sent
   * back to `PlaybackInfo` when switching audio under transcode. */
  index: number;
  kind: MediaStreamKind;
  /** Raw ISO 639-2/B code (e.g. `eng`, `spa`, `und`), or `null` if absent. */
  language: string | null;
  /** Jellyfin's own `DisplayTitle` (falls back to `Title`, then a generic
   * per-kind label) - used as the `languageDisplayName` fallback. */
  displayTitle: string;
  isDefault: boolean;
  isForced: boolean;
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBool(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true;
}

function parseMediaStream(raw: unknown): MediaStreamTrack | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const type = readString(obj, 'Type');
  if (type !== 'Audio' && type !== 'Subtitle') return null;
  const index = obj.Index;
  if (typeof index !== 'number') return null;

  const displayTitle = readString(obj, 'DisplayTitle') ?? readString(obj, 'Title') ?? (type === 'Audio' ? 'Audio' : 'Subtítulo');

  return {
    index,
    kind: type,
    language: readString(obj, 'Language'),
    displayTitle,
    isDefault: readBool(obj, 'IsDefault'),
    isForced: readBool(obj, 'IsForced'),
  };
}

/** Parses Jellyfin's raw `MediaStreams` array, keeping only Audio/Subtitle
 * entries (Video/EmbeddedImage/etc. streams are irrelevant to track menus)
 * and silently dropping anything malformed rather than throwing - a menu
 * missing one weird track beats a player screen that won't load at all. */
export function parseMediaStreamTracks(raw: unknown): MediaStreamTrack[] {
  // Defensive: some Jellyfin responses (e.g. a whole-series item) can return
  // MediaStreams absent or as a non-array shape - never let that white-screen
  // the player, just show no track menus.
  if (!Array.isArray(raw)) return [];
  const parsed: MediaStreamTrack[] = [];
  for (const entry of raw) {
    const track = parseMediaStream(entry);
    if (track) parsed.push(track);
  }
  return parsed;
}

export function audioTracksOf(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  return tracks.filter((t) => t.kind === 'Audio');
}

export function subtitleTracksOf(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  return tracks.filter((t) => t.kind === 'Subtitle');
}

/** Humanized label for a track - `languageDisplayName` with the track's own
 * `displayTitle` as the fallback. */
export function trackLabel(track: MediaStreamTrack): string {
  return languageDisplayName(track.language, track.displayTitle);
}

/** True for the two languages surfaced first in the subtitle menu: Spanish
 * and English (player spec §8, ← `TrackMenu.kt`'s `isPrimaryLanguage`). */
export function isPrimaryLanguage(code: string | null): boolean {
  const c = code?.toLowerCase();
  if (!c) return false;
  return c.startsWith('es') || c.startsWith('en') || ['spa', 'spl', 'esp', 'lat', 'eng'].includes(c);
}

/**
 * Collapses subtitle tracks so each language shows once (a file can carry
 * three "English" streams - full, SDH, forced - the user wants the single
 * best one, not "Inglés 2/3"). Within a language group: default wins, then
 * non-forced over forced, then the lowest stream index for stability. Ported
 * from `TrackMenu.kt`'s `bestPerLanguage`.
 */
export function bestSubtitlePerLanguage(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  const groups = new Map<string, MediaStreamTrack>();
  for (const track of tracks) {
    const key = trackLabel(track);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, track);
      continue;
    }
    if (track.isDefault !== current.isDefault) {
      if (track.isDefault) groups.set(key, track);
      continue;
    }
    if (track.isForced !== current.isForced) {
      if (!track.isForced) groups.set(key, track);
      continue;
    }
    if (track.index < current.index) groups.set(key, track);
  }
  return Array.from(groups.values());
}

/** Appends "2", "3"... to labels that repeat (e.g. three embedded English
 * audio tracks) so every menu row stays distinguishable. Ported from
 * `TrackMenu.kt`'s `disambiguate`. */
export function disambiguateLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  });
}

const DEFAULT_JELLYFIN_BASE: string = import.meta.env.VITE_JELLYFIN_BASE ?? '/jellyfin';

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Builds the Jellyfin subtitle stream delivery URL for a sideloaded
 * `<track>` element - same `api_key` query-string auth as
 * `streamResolver.ts`'s `buildDirectPlayUrl` (a `<video>`/`<track>` element
 * can't send a custom auth header). Shape:
 * `Videos/{itemId}/{mediaSourceId}/Subtitles/{streamIndex}/Stream.{format}?api_key={token}`.
 *
 * NOT live-verified against a real Jellyfin server in this change (no
 * server available in this sandbox) - this mirrors Jellyfin's documented
 * subtitle delivery REST shape, but treat it as the first thing to check if
 * sideloaded subtitles don't render against a real backend.
 */
export function buildSubtitleDeliveryUrl(
  itemId: string,
  mediaSourceId: string,
  streamIndex: number,
  token: string,
  format = 'vtt',
  base: string = DEFAULT_JELLYFIN_BASE,
): string {
  const query = new URLSearchParams();
  query.set('api_key', token);
  return `${normalizeBase(base)}Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/Stream.${format}?${query.toString()}`;
}

/** Fetches + parses the item's `MediaStreams` for the player's track menus
 * (see file header for why this is a second, narrower `getItem` call rather
 * than reusing `usePlaybackInfo`'s). */
export function useItemMediaStreams(itemId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.item(itemId),
    queryFn: async (): Promise<MediaStreamTrack[]> => {
      const item = await getItem(userId, itemId, 'MediaStreams');
      return parseMediaStreamTracks((item.MediaStreams ?? []) as unknown[]);
    },
    enabled: Boolean(itemId && userId),
    staleTime: 0,
    retry: false,
  });
}
