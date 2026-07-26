import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Album detail (Slice 3): the `Audio` tracks under a `MusicAlbum`, in disc /
// track order (`ParentIndexNumber,IndexNumber`). Read straight through the
// Jellyfin proxy, same as the rest of the music library.

export function useAlbumTracks(albumId: string | undefined) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicAlbum(albumId ?? ''),
    queryFn: () =>
      getItems(userId, {
        parentId: albumId,
        includeItemTypes: 'Audio',
        recursive: true,
        sortBy: 'ParentIndexNumber,IndexNumber',
        sortOrder: 'Ascending',
        limit: 200,
        // Carry the fields the cover-art fallback chain needs (album/artist
        // images) so tracks without their own artwork still resolve a cover.
        fields: 'ProviderIds,MediaStreams,Genres,ArtistItems',
      }),
    enabled: Boolean(session) && Boolean(albumId),
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
