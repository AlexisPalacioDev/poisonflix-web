import { useQuery } from '@tanstack/react-query';
import { getItems, getUserViews } from '../api/jellyfin';
import type { JellyfinItem, JellyfinQueryResult } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Home's "Tu biblioteca" row (owned/available titles). Movies AND series,
// sorted by DateCreated desc (getItems' default) - the projector's
// "EN TU LIBRERÍA" is a mixed Movie/Series shelf (walkthrough §4,
// MediaRepositoryImpl.kt's library row), so scoping it to Movie hid every
// owned series (Mr. Robot, Solo Leveling, …). `enabled` gates on a hydrated
// session so this never fires before login.
const LIBRARY_ROW_PARAMS = {
  includeItemTypes: 'Movie,Series',
  recursive: true,
  limit: 40,
} as const;

/** A library is the PIN-gated adult one when named "Adultos" (or containing
 * "adult") - mirrors MediaRepositoryImpl.kt's `isAdultLibrary`. */
export function isAdultLibrary(view: JellyfinItem): boolean {
  const name = view.Name.toLowerCase();
  return name === 'adultos' || name.includes('adult');
}

/**
 * Ids of every Movie/Series in the adult library, so they can be excluded from
 * the mainstream row - otherwise a recursive `getItems` across ALL libraries
 * surfaces ecchi/hentai titles from "Adultos" in "Tu biblioteca" (they belong
 * behind the +18 PIN gate). Empty when there is no adult library.
 */
export async function adultLibraryItemIds(userId: string): Promise<Set<string>> {
  const views = await getUserViews(userId);
  const adult = (views.Items ?? []).find(isAdultLibrary);
  if (!adult) return new Set();
  const items = await getItems(userId, {
    parentId: adult.Id,
    includeItemTypes: 'Movie,Series',
    recursive: true,
    fields: 'ProviderIds',
  });
  return new Set((items.Items ?? []).map((item) => item.Id));
}

export function useLibraryRow() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  return useQuery<JellyfinQueryResult>({
    queryKey: queryKeys.library(userId ?? '', LIBRARY_ROW_PARAMS),
    queryFn: async () => {
      const [result, adultIds] = await Promise.all([
        getItems(userId as string, LIBRARY_ROW_PARAMS),
        adultLibraryItemIds(userId as string),
      ]);
      if (adultIds.size === 0) return result;
      return {
        ...result,
        Items: (result.Items ?? []).filter((item) => !adultIds.has(item.Id)),
      };
    },
    enabled: Boolean(userId),
    // ~60s stale / ~5min gc per design.md §4.2 - MVP has no refetchInterval;
    // the polling seam is additive for the deferred Continue Watching row.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
