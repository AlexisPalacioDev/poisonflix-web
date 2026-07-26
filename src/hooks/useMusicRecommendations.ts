import { useQuery } from '@tanstack/react-query';
import { getRecommendations } from '../api/music';
import type { MusicResultItem } from '../api/schemas/music';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Recomendados para ti" row (Spotify redesign): the worker's suggestion feed.
// `seed` biases the mix toward a track/artist; omitted, it's a general feed.
// Results are the same `song` shape as search, so each one plays/downloads
// through the existing per-result flow on the Música screen.

export function useMusicRecommendations(seed?: string) {
  const { session } = useAuth();

  const query = useQuery({
    queryKey: queryKeys.musicRecommendations(seed ?? ''),
    queryFn: () => getRecommendations(seed),
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
  });

  const items: MusicResultItem[] = query.data ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
