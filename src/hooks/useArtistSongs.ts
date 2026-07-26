import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Track detail "Más de {artista}" section: other `Audio` items credited to the
// same artist as the track being viewed. Filtered by `AlbumArtistIds` — the
// reliable Jellyfin filter for an artist's songs (a `MusicArtist` isn't a folder
// parent, so `ParentId` alone wouldn't return them). The track currently open is
// excluded client-side so the section only ever shows *other* songs. Guarded on
// `artistId`: an item without `ArtistItems` has no artist to expand, so the
// query stays disabled and the section simply doesn't render.
export function useArtistSongs(artistId: string | undefined | null, excludeId?: string) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicArtistSongs(artistId ?? ''),
    queryFn: () =>
      getItems(userId, {
        includeItemTypes: 'Audio',
        albumArtistIds: artistId ?? undefined,
        recursive: true,
        limit: 20,
        fields: 'ArtistItems,AlbumId,AlbumPrimaryImageTag,Genres',
      }),
    enabled: Boolean(session) && Boolean(artistId),
    staleTime: 30_000,
  });

  const items: JellyfinItem[] = (query.data?.Items ?? []).filter(
    (item) => item.Id !== excludeId,
  );

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
