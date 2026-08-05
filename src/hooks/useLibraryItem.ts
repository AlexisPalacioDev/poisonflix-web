import { useQuery } from '@tanstack/react-query';
import { getItem } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Fetches a single Jellyfin item by id - Detail's "Audio disponible" line
// (projector-feature-map.md §7, walkthrough §15) needs the full item's raw
// `MediaStreams`, which `useTitleDetail`'s `LibraryIndex` join never fetches
// (it only reads `ProviderIds` off the library row). Gated on both a
// hydrated session AND a non-null item id, mirroring `useLibraryRow`'s
// session gate; `null` id (not InLibrary, or a series - the audio line is
// movie-only, see DetailScreen) simply never fires the query.
//
// Caches the RAW `JellyfinItem` object under `queryKeys.item`. The player's
// `useItemMediaStreams` deliberately does NOT reuse this key: it caches a
// parsed `MediaStreamTrack[]` instead, and React Query keeps one cache entry
// per key regardless of which components are mounted. A shared key let a movie
// opened in Detail (raw object cached for 60s) hand the player a non-array
// `data` on play, crashing `audioTracksOf` with `.filter is not a function`.
// The player now uses `queryKeys.itemMediaStreams` so the two shapes can never
// collide.
export function useLibraryItem(jellyfinItemId: string | null) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  const query = useQuery<JellyfinItem>({
    queryKey: queryKeys.item(jellyfinItemId ?? ''),
    // UserData carries IsFavorite, which Detail's ⭐ favorite toggle reads to
    // show the current state (in addition to MediaStreams for the audio line).
    queryFn: () => getItem(userId as string, jellyfinItemId as string, 'ProviderIds,MediaStreams,UserData'),
    enabled: Boolean(userId && jellyfinItemId),
    staleTime: 60_000,
  });

  return { item: query.data, isLoading: query.isLoading, isError: query.isError };
}
