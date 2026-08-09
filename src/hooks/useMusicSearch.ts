import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { normalizeMusicSource, searchMusic, warmMusicTrack } from '../api/music';
import type { MusicResultItem, MusicSource } from '../api/schemas/music';
import { queryKeys } from './queryKeys';
import { useDebouncedValue } from './useDebouncedValue';

// YouTube Music search for the Música screen. Same debounced-below-minimum
// shape as the movie/series `useSearch`: the settled query must be 2+ chars
// before any request fires the worker. `source` selects the surface (auto /
// ytmusic / youtube) and is part of the cache key so each toggle state caches
// independently.

const MIN_QUERY_LENGTH = 2;

// How many of the top results get warmed. Measured cold-play latency is
// 2.758s, almost all of it (2.324s) the worker's `yt-dlp -g` resolve — see
// `warmMusicTrack`'s docstring. The user is still reading the list at this
// point, so warming the results they're most likely to tap costs nothing
// they'd notice; warming all of them would just be requests nobody asked for.
const WARM_RESULT_COUNT = 5;

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

  // Cheap ('url' depth) warm for the top of the list, fired the moment
  // results land — while the user is still reading them, before any tap.
  // Skips rows already in the library (`downloaded`): those play straight
  // from Jellyfin and never touch the worker's yt-dlp/ffmpeg pipeline at all,
  // so warming them would be a request the worker can't do anything useful
  // with. Album/playlist hits are skipped too — this endpoint warms one
  // videoId, not a collection.
  useEffect(() => {
    if (results.length === 0) return;
    let warmed = 0;
    for (const result of results) {
      if (warmed >= WARM_RESULT_COUNT) break;
      if (result.type !== 'song' || result.downloaded) continue;
      warmMusicTrack(result.videoId, normalizeMusicSource(result.source), 'url');
      warmed += 1;
    }
  }, [results]);

  return {
    debouncedQuery: trimmed,
    enabled,
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError,
    results,
    refetch: query.refetch,
  };
}
