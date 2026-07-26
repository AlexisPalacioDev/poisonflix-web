import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPlayedAudioWithRuntime } from '../api/jellyfin';
import { getPreviewPlays } from '../api/music';
import {
  minutesOf,
  talliesFromItems,
  topArtistsOf,
  topTracksOf,
  totalPlaysOf,
  type PlayTally,
  type TopEntry,
} from '../lib/domain/usageStats';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Tu música": this user's own listening.
//
// It comes from TWO stores, and using either alone reports something that is
// true but is not the answer. Jellyfin's UserData covers what was played from
// the library — per user by construction, since the request carries their
// token. But a preview (a radio pick or a search hit streamed straight from
// YouTube) has no Jellyfin item, so nothing there can be counted; the worker
// tallies those by videoId instead.
//
// Since autoplay radio landed, previews are most of what actually plays, which
// is why the Jellyfin-only version of this panel read near zero for a user who
// listens every day. Both sources are mapped onto `PlayTally` and every top-N
// runs over the union.

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

  const library = useQuery({
    queryKey: queryKeys.myMusicStats(userId),
    queryFn: () => getPlayedAudioWithRuntime(userId),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  // Independent query on purpose: one store being unreachable must degrade the
  // number, never blank the panel that the other store could still fill.
  const previews = useQuery({
    queryKey: queryKeys.previewPlays(userId),
    queryFn: getPreviewPlays,
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const tallies = useMemo<PlayTally[]>(
    () => [
      ...talliesFromItems(library.data?.Items ?? []),
      ...(previews.data ?? []).map((play) => ({
        key: play.videoId,
        title: play.title,
        artist: play.artist || null,
        plays: play.count,
        seconds: play.seconds,
      })),
    ],
    [library.data, previews.data],
  );

  const totalPlays = totalPlaysOf(tallies);

  return {
    artists: topArtistsOf(tallies),
    tracks: topTracksOf(tallies),
    minutes: minutesOf(tallies),
    totalPlays,
    hasHistory: totalPlays > 0,
    isLoading: library.isLoading || previews.isLoading,
  };
}
