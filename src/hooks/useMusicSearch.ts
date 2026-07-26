import { useQuery } from '@tanstack/react-query';
import { searchMusic } from '../api/music';
import type { MusicResultItem, MusicSource } from '../api/schemas/music';
import { queryKeys } from './queryKeys';
import { useDebouncedValue } from './useDebouncedValue';

// YouTube Music search for the Música screen. Same debounced-below-minimum
// shape as the movie/series `useSearch`: the settled query must be 2+ chars
// before any request fires the worker. `source` selects the surface (auto /
// ytmusic / youtube) and is part of the cache key so each toggle state caches
// independently.

const MIN_QUERY_LENGTH = 2;

export function useMusicSearch(rawQuery: string, source: MusicSource = 'auto') {
  const debounced = useDebouncedValue(rawQuery, 350);
  const trimmed = debounced.trim();
  const enabled = trimmed.length >= MIN_QUERY_LENGTH;

  const query = useQuery({
    queryKey: queryKeys.musicSearch(trimmed, source),
    queryFn: () => searchMusic(trimmed, source),
    enabled,
    staleTime: 60_000,
  });

  const results: MusicResultItem[] = query.data ?? [];

  return {
    debouncedQuery: trimmed,
    enabled,
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError,
    results,
    refetch: query.refetch,
  };
}
