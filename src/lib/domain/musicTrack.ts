import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicSearchResult, MusicSource } from '../../api/schemas/music';
import { resolveCoverUrl } from './posterUrl';

// Shared mapping from a Jellyfin `Audio` item to the player's `MusicTrack`
// shape. Extracted so every music surface (the library list, album detail,
// enqueue actions) builds tracks identically: first credited artist, falling
// back to the album artist, and the best-available artwork via the cover-art
// fallback chain (own image -> album -> artist -> ♪ placeholder). Because the
// MediaSession lock-screen artwork also reads `coverUrl`, the fallback flows
// through to the lock screen with no extra wiring.
export interface AudioTrack {
  itemId: string;
  title: string;
  artist: string | null;
  coverUrl: string | null;
  artistId: string | null;
}

export function audioItemToTrack(item: JellyfinItem, token: string | null): AudioTrack {
  const artist = item.Artists?.[0] ?? item.AlbumArtist ?? null;
  // First credited artist's id, used to make the artist name tappable in the
  // full-screen mobile player. Absent for items without ArtistItems.
  const artistId = item.ArtistItems?.[0]?.Id ?? null;
  return {
    itemId: item.Id,
    title: item.Name,
    artist,
    coverUrl: resolveCoverUrl(item, token),
    artistId,
  };
}

// The same mapping for the other side of Música: a search / recommendation hit
// from the worker. Downloaded hits play the real Jellyfin item (so they behave
// like any library track); the rest play through the worker's stream proxy. Both
// kinds are plain `MusicTrack`s, so a radio can mix them in one queue.
export interface SearchTrack {
  itemId: string;
  title: string;
  artist: string | null;
  coverUrl: string | null;
  streamUrl?: string;
  // Kept even for downloaded hits: it's the seed autoplay uses to build the
  // radio that follows this track, and it saves the worker a reverse lookup.
  videoId: string;
  // The length the search result already reported, so the player has a scale
  // before the audio element finds one.
  durationSeconds?: number | null;
}

/** The /bff/music/stream proxy URL that plays a videoId without downloading it. */
export function previewStreamUrl(videoId: string, source?: string | null): string {
  const params = new URLSearchParams({ videoId });
  if (source === 'ytmusic' || source === 'youtube') params.set('source', source);
  return `/bff/music/stream?${params.toString()}`;
}

/**
 * The inverse of `previewStreamUrl`: recovers which surface a preview URL was
 * built for straight out of its own `source` query param, for callers (like
 * the queue's next-track warm) that only ever kept the built URL and not the
 * original search hit it came from. Falls back to 'auto' both when the param
 * is missing and when it isn't one of the two explicit worker sources — the
 * same fallback `previewStreamUrl` itself applies when building the URL, and
 * the worker's own default for an omitted `source`. Defensive by
 * construction: a relative or malformed URL is resolved against a throwaway
 * base rather than thrown on, so this never raises regardless of input.
 */
export function streamUrlSource(streamUrl: string | null | undefined): MusicSource {
  if (!streamUrl) return 'auto';
  try {
    const source = new URL(streamUrl, 'http://localhost').searchParams.get('source');
    return source === 'ytmusic' || source === 'youtube' ? source : 'auto';
  } catch {
    return 'auto';
  }
}

export function searchResultToTrack(result: MusicSearchResult): SearchTrack {
  const base = {
    title: result.title ?? 'Sin título',
    artist: result.artist ?? null,
    coverUrl: result.thumbnailUrl ?? null,
    durationSeconds: result.durationSeconds ?? null,
  };
  if (result.downloaded && result.jellyfinItemId) {
    return { itemId: result.jellyfinItemId, videoId: result.videoId, ...base };
  }
  return {
    itemId: result.videoId,
    videoId: result.videoId,
    ...base,
    streamUrl: previewStreamUrl(result.videoId, result.source),
  };
}

/**
 * Whether a search / recommendation row is the track the player currently has
 * loaded — the flag that turns its ▶ into ⏸ instead of leaving a stale play
 * glyph on the song you're listening to.
 *
 * Two ways to match, because the same song reaches the player by two routes.
 * A row played as a preview carries the videoId; the very same song played from
 * the library (or after downloading) is a Jellyfin item and knows only its
 * itemId. Matching either means the row lights up however it started playing.
 */
export function isRowActive(
  current: { itemId: string; videoId?: string | null } | null,
  row: { videoId: string; playItemId?: string | null },
): boolean {
  if (!current) return false;
  if (current.videoId && current.videoId === row.videoId) return true;
  // A preview track stores its videoId in `itemId`; a library track stores the
  // Jellyfin id, which the row only knows once it is downloaded.
  if (current.itemId === row.videoId) return true;
  return Boolean(row.playItemId && current.itemId === row.playItemId);
}
