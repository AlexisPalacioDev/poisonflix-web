import { useQuery } from '@tanstack/react-query';
import { getPlaylistTracks } from '../api/playlists';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Playlist detail (/musica/playlist/:id): the tracks of one user playlist, in
// playlist order. Each item carries a `PlaylistItemId` (its membership id) so a
// row's "Quitar" can remove that exact entry.
export function usePlaylistTracks(playlistId: string | undefined) {
  const { session } = useAuth();

  const query = useQuery({
    queryKey: queryKeys.userPlaylist(playlistId ?? ''),
    queryFn: () => getPlaylistTracks(playlistId as string),
    enabled: Boolean(session) && Boolean(playlistId),
    staleTime: 15_000,
  });

  const items: JellyfinItem[] = query.data?.Items ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
