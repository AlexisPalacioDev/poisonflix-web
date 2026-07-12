import { useQuery } from '@tanstack/react-query';
import { discoverTrending } from '../api/jellyseerr';
import { queryKeys } from './queryKeys';

// Home's Trending row (design.md §4.1/§4.2, home spec's "Fixed MVP row set").
// Independent useQuery from useLibraryRow (ADR-3, row isolation) - this row
// has no `enabled` gate on the session because discoverTrending doesn't need
// a userId, only the same-origin Jellyseerr cookie.
export function useTrendingRow() {
  return useQuery({
    queryKey: queryKeys.trending(),
    queryFn: () => discoverTrending(),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
