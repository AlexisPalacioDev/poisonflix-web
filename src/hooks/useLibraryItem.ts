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
// Shares `queryKeys.item` with the player feature's `useItemMediaStreams`
// (`features/player/mediaStreamTracks.ts`) - same key shape, same narrow
// `Fields` request. Both screens are never mounted at once, so there is no
// concurrent-fetch collision in practice (same accepted duplication that
// file's own header already documents).
export function useLibraryItem(jellyfinItemId: string | null) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  const query = useQuery<JellyfinItem>({
    queryKey: queryKeys.item(jellyfinItemId ?? ''),
    queryFn: () => getItem(userId as string, jellyfinItemId as string, 'ProviderIds,MediaStreams'),
    enabled: Boolean(userId && jellyfinItemId),
    staleTime: 60_000,
  });

  return { item: query.data, isLoading: query.isLoading, isError: query.isError };
}
