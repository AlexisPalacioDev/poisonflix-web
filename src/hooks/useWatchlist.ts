import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addToWatchlist, getWatchlist, removeFromWatchlist, type WatchlistItemParams } from '../api/bff';
import type { WatchlistEntry } from '../api/schemas/bff';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Mi lista" (watchlist) data layer. The BFF returns the full updated list from
// every add/remove, so the mutations write that straight into the query cache
// (no refetch round-trip). Identity is server-side (session cookie), so nothing
// here passes a user id.

export function useWatchlist() {
  const { session } = useAuth();
  return useQuery({
    queryKey: queryKeys.watchlist(),
    queryFn: getWatchlist,
    // Gated on a hydrated session like the other rows - never fires before login.
    enabled: Boolean(session?.jellyfinUserId),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

export function useAddToWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entry: WatchlistItemParams) => addToWatchlist(entry),
    onSuccess: (items) => queryClient.setQueryData(queryKeys.watchlist(), items),
  });
}

export function useRemoveFromWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tmdbId, mediaType }: { tmdbId: number; mediaType: 'movie' | 'tv' }) =>
      removeFromWatchlist(tmdbId, mediaType),
    onSuccess: (items) => queryClient.setQueryData(queryKeys.watchlist(), items),
  });
}

/** A movie and a TV show can share a TMDB id, so membership is the pair. */
export function isInWatchlist(
  items: WatchlistEntry[] | undefined,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
): boolean {
  return (items ?? []).some((e) => e.tmdbId === tmdbId && e.mediaType === mediaType);
}
