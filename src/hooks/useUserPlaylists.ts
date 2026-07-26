import { useQuery } from '@tanstack/react-query';
import { getUserPlaylists } from '../api/playlists';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// The user's own playlists (Playlists tab + the add-to-playlist menu). Gated by
// `enabled` so the add-to-playlist popover only fetches once it's actually
// opened, and the Playlists browse tab only once selected.
export function useUserPlaylists(enabled = true) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.userPlaylists(userId),
    queryFn: getUserPlaylists,
    enabled: Boolean(session) && enabled,
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
