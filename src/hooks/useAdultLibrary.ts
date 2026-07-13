import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteItem, getItems, getUserViews } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { isAdultLibrary } from './useLibraryRow';
import { useAdultUnlocked } from './useAdultUnlocked';
import { useAuth } from './useAuth';

// Downloaded +18 titles - the Movie/Series in the PIN-gated "Adultos" Jellyfin
// library. Adult content is grabbed straight through Prowlarr (no Jellyseerr
// request record, so it never shows in the normal Downloads list), so this is
// the only surface where a user can see and delete it. Gated on the same PIN
// unlock as the rest of the +18 UI.

const ADULT_LIBRARY_KEY = ['jellyfin', 'adultLibrary'] as const;

async function fetchAdultLibraryItems(userId: string): Promise<JellyfinItem[]> {
  const views = await getUserViews(userId);
  const adult = (views.Items ?? []).find(isAdultLibrary);
  if (!adult) return [];
  const items = await getItems(userId, {
    parentId: adult.Id,
    includeItemTypes: 'Movie,Series',
    recursive: true,
    limit: 60,
    fields: 'ProviderIds',
  });
  return items.Items ?? [];
}

export function useAdultLibraryItems() {
  const { session } = useAuth();
  const unlocked = useAdultUnlocked();
  const userId = session?.jellyfinUserId;

  return useQuery({
    queryKey: ADULT_LIBRARY_KEY,
    queryFn: () => fetchAdultLibraryItems(userId as string),
    enabled: unlocked && Boolean(userId),
    staleTime: 30_000,
  });
}

/** Delete a +18 title straight through Jellyfin, then refresh the adult row. */
export function useDeleteAdultItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => deleteItem(itemId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADULT_LIBRARY_KEY }),
  });
}
