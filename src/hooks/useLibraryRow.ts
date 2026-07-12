import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Home's Library row (design.md §4.1/§4.2, home spec's "Fixed MVP row set").
// Movies only for the MVP row (mirrors HomeViewModel.kt's library row scope);
// `enabled` gates on a hydrated session so this never fires before login.
const LIBRARY_ROW_PARAMS = {
  includeItemTypes: 'Movie',
  recursive: true,
  limit: 40,
} as const;

export function useLibraryRow() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  return useQuery({
    queryKey: queryKeys.library(userId ?? '', LIBRARY_ROW_PARAMS),
    queryFn: () => getItems(userId as string, LIBRARY_ROW_PARAMS),
    enabled: Boolean(userId),
    // ~60s stale / ~5min gc per design.md §4.2 - MVP has no refetchInterval;
    // the polling seam is additive for the deferred Continue Watching row.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
