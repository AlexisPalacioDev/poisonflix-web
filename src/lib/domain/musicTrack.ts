import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicSearchResult } from '../../api/schemas/music';
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
}

/** The /bff/music/stream proxy URL that plays a videoId without downloading it. */
export function previewStreamUrl(videoId: string, source?: string | null): string {
  const params = new URLSearchParams({ videoId });
  if (source === 'ytmusic' || source === 'youtube') params.set('source', source);
  return `/bff/music/stream?${params.toString()}`;
}

export function searchResultToTrack(result: MusicSearchResult): SearchTrack {
  const base = {
    title: result.title ?? 'Sin título',
    artist: result.artist ?? null,
    coverUrl: result.thumbnailUrl ?? null,
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
