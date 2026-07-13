import { useQuery } from '@tanstack/react-query';
import { getResumeItems } from '../api/jellyfin';
import type { JellyfinQueryResult } from '../api/schemas/jellyfin';
import { adultLibraryItemIds } from './useLibraryRow';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Home's "Continuar viendo" row source (projector-feature-map.md §3 row 1,
// walkthrough §2). Polls the Jellyfin resume feed every 20s while Home is
// mounted, mirroring HomeViewModel.kt's cadence (native reference polls only
// while Home is resumed via `LifecycleResumeEffect`; react-query's own
// window-focus/mount lifecycle covers that here without extra wiring).
const RESUME_ROW_PARAMS = { limit: 20 } as const;

export function useResumeRow() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  return useQuery<JellyfinQueryResult>({
    queryKey: queryKeys.resumeRow(userId ?? ''),
    // The raw `/Items/Resume` feed spans EVERY library the Jellyfin user can
    // read - including the PIN-gated "Adultos" one - so an in-progress +18
    // title would otherwise surface on Home with no PIN. Exclude adult titles
    // here the same way `useLibraryRow` does for "Tu biblioteca": movies match
    // the adult set by their own Id, episodes by their parent `SeriesId`
    // (the resume feed returns Episodes, whose Ids differ from the Series Id
    // that lives in the adult set).
    queryFn: async () => {
      const [result, adultIds] = await Promise.all([
        getResumeItems(userId as string, RESUME_ROW_PARAMS),
        adultLibraryItemIds(userId as string),
      ]);
      if (adultIds.size === 0) return result;
      return {
        ...result,
        Items: (result.Items ?? []).filter(
          (item) => !adultIds.has(item.Id) && !(item.SeriesId != null && adultIds.has(item.SeriesId)),
        ),
      };
    },
    // Gated on a hydrated session like useLibraryRow - never fires before login.
    enabled: Boolean(userId),
    refetchInterval: 20_000,
  });
}
