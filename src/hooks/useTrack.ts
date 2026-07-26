import { useQuery } from '@tanstack/react-query';
import { getItem } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Track detail (/musica/track/:id): the single Jellyfin `Audio` item behind a
// song row. Fetched with `Genres,ArtistItems` in `Fields` so the detail screen
// can list genres and link straight to the credited artist's page; `AlbumId`,
// `ProductionYear` and `RunTimeTicks` come back on the single-item endpoint by
// default. Keyed on its own `musicTrack` key (never the shared `item` key,
// which the player caches under a different shape — see useLibraryItem).
export function useTrack(trackId: string | undefined) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery<JellyfinItem>({
    queryKey: queryKeys.musicTrack(trackId ?? ''),
    queryFn: () =>
      getItem(userId, trackId as string, 'ProviderIds,MediaStreams,Genres,ArtistItems'),
    enabled: Boolean(session) && Boolean(trackId),
    staleTime: 30_000,
  });

  return {
    item: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
