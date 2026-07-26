import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Tu música" — the user's Jellyfin Audio library, newest first. Reads straight
// through the existing Jellyfin proxy with the user's own token (same model as
// the video library rows); the worker only writes files + triggers scans.

const MUSIC_LIBRARY_PARAMS = {
  includeItemTypes: 'Audio',
  recursive: true,
  sortBy: 'DateCreated',
  sortOrder: 'Descending',
  limit: 100,
  // `ArtistItems`/`Genres` are only returned when asked for; `AlbumId` and
  // `AlbumPrimaryImageTag` ride along with Audio items. Needed so the cover-art
  // fallback chain (resolveCoverUrl) can reach the album/artist images.
  fields: 'ProviderIds,MediaStreams,Genres,ArtistItems',
} as const;

export function useMusicLibrary() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicLibrary(userId),
    queryFn: () => getItems(userId, MUSIC_LIBRARY_PARAMS),
    enabled: Boolean(session),
    staleTime: 10_000,
  });

  const items: JellyfinItem[] = query.data?.Items ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
