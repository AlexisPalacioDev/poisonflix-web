import { useQueries, useQuery } from '@tanstack/react-query';
import { getActivityEntries, getActiveSessions, getJellyfinUsers } from '../api/jellyfin';
import { dailyPlays, playbackEvents, usageByUser, type UserUsage } from '../lib/domain/usageStats';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Admin view: who is using the server and how much, from Jellyfin's activity
// log. The log is rolling, so this is deliberately framed as "lately" — see
// `usageStats`. Live sessions refresh on their own cadence because "ahora
// mismo" is worthless if it's a minute stale.

const SESSIONS_REFETCH_MS = 15_000;

export interface ServerUsage {
  users: UserUsage[];
  daily: number[];
  totalPlays: number;
  isLoading: boolean;
  isError: boolean;
}

export function useServerUsage(days = 30, enabled = true, now = new Date()): ServerUsage {
  const [activity, users] = useQueries({
    queries: [
      {
        queryKey: queryKeys.serverUsage(days),
        queryFn: () =>
          getActivityEntries({
            limit: 500,
            minDate: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
          }),
        enabled,
        staleTime: 60_000,
      },
      {
        queryKey: ['usage', 'users'] as const,
        queryFn: getJellyfinUsers,
        enabled,
        staleTime: 10 * 60_000,
      },
    ],
  });

  const events = playbackEvents(activity.data?.Items ?? []);
  return {
    users: usageByUser(events, users.data ?? []),
    daily: dailyPlays(events, days, now),
    totalPlays: events.length,
    isLoading: activity.isLoading || users.isLoading,
    isError: activity.isError || users.isError,
  };
}

export function useActiveSessions(enabled = true) {
  const { session } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.activeSessions(),
    queryFn: getActiveSessions,
    enabled: enabled && Boolean(session),
    refetchInterval: SESSIONS_REFETCH_MS,
    staleTime: 0,
  });
  // Only sessions actually playing something: a dozen idle clients say nothing
  // about usage and would bury the one that matters.
  const playing = (query.data ?? []).filter((s) => s.NowPlayingItem);
  return { playing, isLoading: query.isLoading, isError: query.isError };
}
