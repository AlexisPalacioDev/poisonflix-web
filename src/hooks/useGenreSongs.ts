import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Songs under one selected genre (Géneros tab). Filters the user's Audio
// library by the Jellyfin genre tag. Disabled until a genre chip is tapped, so
// no request fires just for opening the tab.

export function useGenreSongs(genre: string | null) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicGenreSongs(userId, genre ?? ''),
    queryFn: () =>
      getItems(userId, {
        includeItemTypes: 'Audio',
        recursive: true,
        genres: genre ?? undefined,
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 100,
        // Fields for the cover-art fallback chain (album/artist images).
        fields: 'ProviderIds,MediaStreams,Genres,ArtistItems',
      }),
    enabled: Boolean(session) && Boolean(genre),
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
