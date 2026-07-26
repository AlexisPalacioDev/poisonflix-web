import { useQuery } from '@tanstack/react-query';
import { getPlayedAudioWithRuntime } from '../api/jellyfin';
import {
  estimateListeningMinutes,
  topArtists,
  topTracks,
  type TopEntry,
} from '../lib/domain/usageStats';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Tu música": this user's own listening, from their own Jellyfin UserData.
// Per user by construction — the request carries their token, so it can only
// ever return their history.

export interface MyMusicStats {
  artists: TopEntry[];
  tracks: TopEntry[];
  minutes: number;
  totalPlays: number;
  hasHistory: boolean;
  isLoading: boolean;
}

export function useMyMusicStats(): MyMusicStats {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.myMusicStats(userId),
    queryFn: () => getPlayedAudioWithRuntime(userId),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const items = query.data?.Items ?? [];
  const totalPlays = items.reduce((sum, item) => sum + (item.UserData?.PlayCount ?? 0), 0);

  return {
    artists: topArtists(items),
    tracks: topTracks(items),
    minutes: estimateListeningMinutes(items),
    totalPlays,
    hasHistory: totalPlays > 0,
    isLoading: query.isLoading,
  };
}
