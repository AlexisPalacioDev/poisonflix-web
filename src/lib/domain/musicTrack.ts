import type { JellyfinItem } from '../../api/schemas/jellyfin';
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
