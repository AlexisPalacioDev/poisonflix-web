import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Artistas browse tab (Slice 3): the user's Jellyfin `MusicArtist` items,
// alphabetically. Gated by `enabled` so it only fetches when its tab is open.

const MUSIC_ARTISTS_PARAMS = {
  includeItemTypes: 'MusicArtist',
  recursive: true,
  sortBy: 'SortName',
  sortOrder: 'Ascending',
  limit: 100,
} as const;

export function useMusicArtists(enabled = true) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicArtists(userId),
    queryFn: () => getItems(userId, MUSIC_ARTISTS_PARAMS),
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
