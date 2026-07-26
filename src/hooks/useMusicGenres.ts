import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Géneros browse tab (Spotify redesign): the distinct `MusicGenre` items in the
// user's library, alphabetically. Same read-through-the-proxy model as the
// album/artist grids (MusicAlbum / MusicArtist -> MusicGenre). Gated by
// `enabled` so it only fetches once the Géneros tab is opened. Genres come from
// Jellyfin's own tags — whatever the library actually carries shows up.

const MUSIC_GENRES_PARAMS = {
  includeItemTypes: 'MusicGenre',
  recursive: true,
  sortBy: 'SortName',
  sortOrder: 'Ascending',
  limit: 200,
} as const;

export function useMusicGenres(enabled = true) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicGenres(userId),
    queryFn: () => getItems(userId, MUSIC_GENRES_PARAMS),
    enabled: Boolean(session) && enabled,
    staleTime: 60_000,
  });

  const items: JellyfinItem[] = query.data?.Items ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
