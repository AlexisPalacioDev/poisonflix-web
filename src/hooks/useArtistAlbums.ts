import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Artist detail (Slice 3): every `MusicAlbum` credited to an artist, newest
// first. Filtered by `AlbumArtistIds` — the reliable Jellyfin filter for an
// artist's albums (a `MusicArtist` isn't a folder parent, so `ParentId` alone
// wouldn't return them).

export function useArtistAlbums(artistId: string | undefined) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicArtist(artistId ?? ''),
    queryFn: () =>
      getItems(userId, {
        includeItemTypes: 'MusicAlbum',
        recursive: true,
        albumArtistIds: artistId,
        sortBy: 'ProductionYear,SortName',
        sortOrder: 'Descending',
        limit: 100,
      }),
    enabled: Boolean(session) && Boolean(artistId),
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
