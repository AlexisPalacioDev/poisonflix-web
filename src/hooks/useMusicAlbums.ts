import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Álbumes browse tab (Slice 3): the user's Jellyfin `MusicAlbum` items, sorted
// alphabetically. Same read-through-the-proxy model as `useMusicLibrary`. The
// query is gated by `enabled` so the album grid only fetches once its tab is
// opened (the Canciones tab is the default and shouldn't pay for this).

const MUSIC_ALBUMS_PARAMS = {
  includeItemTypes: 'MusicAlbum',
  recursive: true,
  sortBy: 'SortName',
  sortOrder: 'Ascending',
  limit: 100,
} as const;

export function useMusicAlbums(enabled = true) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicAlbums(userId),
    queryFn: () => getItems(userId, MUSIC_ALBUMS_PARAMS),
    enabled: Boolean(session) && enabled,
    staleTime: 30_000,
  });

  const items: JellyfinItem[] = query.data?.Items ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
