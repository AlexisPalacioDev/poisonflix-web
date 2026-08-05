import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getItems, setFavorite } from '../api/jellyfin';
import type { JellyfinQueryResult } from '../api/schemas/jellyfin';
import { adultLibraryItemIds } from './useLibraryRow';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Mis favoritos" row + favorite toggle. Favorites are a native Jellyfin
// per-user flag (UserData.IsFavorite), so this needs no BFF - the row is just a
// filtered library query and the toggle is a POST/DELETE straight to Jellyfin.
const FAVORITES_ROW_PARAMS = {
  includeItemTypes: 'Movie,Series',
  recursive: true,
  filters: 'IsFavorite',
  limit: 40,
} as const;

export function useFavoritesRow() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  return useQuery<JellyfinQueryResult>({
    queryKey: queryKeys.favoritesRow(userId ?? ''),
    // Exclude +18 titles the same way "Tu biblioteca" does: a favorited adult
    // title must stay behind the PIN gate, never surface on Home.
    queryFn: async () => {
      const [result, adultIds] = await Promise.all([
        getItems(userId as string, FAVORITES_ROW_PARAMS),
        adultLibraryItemIds(userId as string),
      ]);
      if (adultIds.size === 0) return result;
      return {
        ...result,
        Items: (result.Items ?? []).filter((item) => !adultIds.has(item.Id)),
      };
    },
    enabled: Boolean(userId),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

/** Mark/unmark a library item as favorite; refreshes the row + that item. */
export function useToggleFavorite() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ itemId, on }: { itemId: string; on: boolean }) =>
      setFavorite(userId as string, itemId, on),
    onSuccess: (_data, { itemId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.favoritesRow(userId ?? '') });
      queryClient.invalidateQueries({ queryKey: queryKeys.item(itemId) });
    },
  });
}
