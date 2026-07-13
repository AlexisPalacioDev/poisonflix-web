import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import { getSonarrEpisodes, getSonarrQueue, getSonarrSeries } from '../api/arr';
import type { SonarrEpisode } from '../api/schemas/arr';
import { jellyfinPosterUrl } from '../lib/domain/posterUrl';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// TV series episode list for Detail's two-pane layout (projector-feature-map.md
// §7 "TV SERIES layout", walkthrough §19/§20), ported from
// `EpisodeRepositoryImpl.kt`'s merge rule.
//
// Jellyfin owns the PLAYABLE truth: an episode present there is `Available`
// and carries the `jellyfinItemId` the player route needs - same "Jellyfin
// presence wins" decision `lib/domain/libraryIndex.ts` already makes at the
// title level. Sonarr contributes the FULL canonical episode list (so
// not-yet-downloaded episodes still show up as `Missing`/`Downloading`
// instead of vanishing) plus the real per-episode download %.
//
// Sonarr 401s without a provisioned API key in this dev environment (task
// constraint - same as `useCancelDownload`'s Radarr/Sonarr steps): every
// Sonarr call below is independently try/caught, so a 401/outage degrades to
// Jellyfin-only episodes (no Missing/Downloading rows, no crash) rather than
// blanking the whole two-pane layout. Jellyfin failures are caught the same
// way, for the same reason.

export type EpisodeStatus =
  | { kind: 'Available'; jellyfinItemId: string }
  | { kind: 'Downloading'; percent: number }
  | { kind: 'Missing' };

export interface SeriesEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string | null;
  stillUrl: string | null;
  status: EpisodeStatus;
}

interface JellyfinEpisodeInfo {
  jellyfinItemId: string;
  title: string | null;
  overview: string | null;
  stillUrl: string | null;
}

function episodeKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}

/** Jellyfin's playable episodes for one series, keyed by (season, episode). Best-effort: a fetch failure yields an empty map rather than throwing. */
async function loadJellyfinEpisodes(
  userId: string,
  seriesJellyfinItemId: string,
  token: string | null,
): Promise<Map<string, JellyfinEpisodeInfo>> {
  const map = new Map<string, JellyfinEpisodeInfo>();
  try {
    const result = await getItems(userId, {
      parentId: seriesJellyfinItemId,
      includeItemTypes: 'Episode',
      recursive: true,
      fields: 'Overview,ProviderIds,ImageTags',
    });
    for (const item of result.Items) {
      if (item.IndexNumber == null) continue;
      const season = item.ParentIndexNumber ?? 0;
      map.set(episodeKey(season, item.IndexNumber), {
        jellyfinItemId: item.Id,
        title: item.Name,
        overview: item.Overview ?? null,
        stillUrl: jellyfinPosterUrl(item, token),
      });
    }
  } catch {
    // Best-effort - an unreachable Jellyfin episode list must not crash the
    // whole two-pane layout; the caller still gets Sonarr's rows, if any.
  }
  return map;
}

interface SonarrLoadResult {
  episodes: SonarrEpisode[];
  percentByEpisodeId: Map<number, number>;
}

/** Download completion 0..100, or null if the total size is unknown - same rule as `lib/domain/downloadProgress.ts`'s `percentOf` (not exported from there, so intentionally duplicated here; both are ~5 lines). */
function queuePercent(size: number, sizeleft: number): number | null {
  if (size <= 0) return null;
  return Math.min(100, Math.max(0, ((size - sizeleft) / size) * 100));
}

/** Sonarr's full episode list + a queue-derived percent map, matched by tmdbId or (fallback) tvdbId. Every step is independently best-effort. */
async function loadSonarrEpisodes(tmdbId: number | null, tvdbId: number | null): Promise<SonarrLoadResult> {
  const empty: SonarrLoadResult = { episodes: [], percentByEpisodeId: new Map() };
  if (tmdbId == null && tvdbId == null) return empty;

  try {
    const seriesList = await getSonarrSeries();
    const series = seriesList.find(
      (s) => (tmdbId != null && s.tmdbId === tmdbId) || (tvdbId != null && s.tvdbId === tvdbId),
    );
    if (!series) return empty;

    const episodes = await getSonarrEpisodes(series.id);

    const percentByEpisodeId = new Map<number, number>();
    try {
      const queue = await getSonarrQueue(true);
      for (const record of queue.records) {
        if (record.seriesId !== series.id || record.episodeId == null) continue;
        const percent = queuePercent(record.size, record.sizeleft);
        if (percent != null) percentByEpisodeId.set(record.episodeId, percent);
      }
    } catch {
      // Best-effort - an unreachable queue still leaves the full episode list.
    }

    return { episodes, percentByEpisodeId };
  } catch {
    // Sonarr 401s without an API key in this dev env - degrade to
    // Jellyfin-only (no Missing/Downloading rows), no crash.
    return empty;
  }
}

/**
 * Merges Jellyfin's playable episodes with Sonarr's full list + queue %,
 * keyed by (season, episode) - `EpisodeRepositoryImpl.kt`'s merge rule
 * verbatim: Jellyfin presence wins (`Available`); else Sonarr's queue %
 * (`Downloading`); else `Missing`. Season 0 "specials" are hidden UNLESS
 * Jellyfin actually has the file (a playable special must never be hidden).
 */
export function mergeEpisodes(
  jellyfin: Map<string, JellyfinEpisodeInfo>,
  sonarrEpisodes: SonarrEpisode[],
  percentByEpisodeId: Map<number, number>,
): SeriesEpisode[] {
  const sonarrByKey = new Map<string, SonarrEpisode>();
  for (const ep of sonarrEpisodes) {
    sonarrByKey.set(episodeKey(ep.seasonNumber, ep.episodeNumber), ep);
  }

  const keys = new Set<string>([...jellyfin.keys(), ...sonarrByKey.keys()]);
  const episodes: SeriesEpisode[] = [];

  for (const key of keys) {
    const [seasonStr, episodeStr] = key.split(':');
    const seasonNumber = Number(seasonStr);
    const episodeNumber = Number(episodeStr);

    const jf = jellyfin.get(key);
    if (seasonNumber < 1 && !jf) continue;

    const sonarr = sonarrByKey.get(key);
    const status: EpisodeStatus = jf
      ? { kind: 'Available', jellyfinItemId: jf.jellyfinItemId }
      : sonarr && percentByEpisodeId.has(sonarr.id)
        ? { kind: 'Downloading', percent: percentByEpisodeId.get(sonarr.id) as number }
        : { kind: 'Missing' };

    episodes.push({
      seasonNumber,
      episodeNumber,
      title: jf?.title ?? sonarr?.title ?? `Episodio ${episodeNumber}`,
      overview: jf?.overview ?? null,
      stillUrl: jf?.stillUrl ?? null,
      status,
    });
  }

  episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  return episodes;
}

/** Groups an already season/episode-sorted list by season number, preserving episode order within each season. */
export function groupBySeason(episodes: SeriesEpisode[]): Map<number, SeriesEpisode[]> {
  const map = new Map<number, SeriesEpisode[]>();
  for (const episode of episodes) {
    const list = map.get(episode.seasonNumber);
    if (list) {
      list.push(episode);
    } else {
      map.set(episode.seasonNumber, [episode]);
    }
  }
  return map;
}

/**
 * Whole-series completeness as a single 0..99 percentage: every episode
 * contributes its own readiness (Available = 1, Downloading = its fraction,
 * Missing = 0), averaged over ALL episodes. Returns `null` when there are no
 * episodes or the series is already fully available (100%) - in both cases
 * there is no progress bar to show. Ported from `DetailViewModel.kt`'s
 * `seriesCompleteness` verbatim.
 */
export function seriesCompleteness(episodes: SeriesEpisode[]): number | null {
  if (episodes.length === 0) return null;

  const readiness = episodes.reduce((sum, episode) => {
    switch (episode.status.kind) {
      case 'Available':
        return sum + 1;
      case 'Downloading':
        return sum + Math.min(1, Math.max(0, episode.status.percent / 100));
      case 'Missing':
        return sum;
    }
  }, 0);

  const percent = Math.floor((readiness / episodes.length) * 100);
  return percent >= 100 ? null : percent;
}

/**
 * Default season for the two-pane layout: the lowest season number that has
 * at least one Available (playable) episode, falling back to the lowest
 * season number overall when nothing is playable yet. Ported from
 * `DetailViewModel.kt`'s `defaultSeasonFor` verbatim.
 */
export function defaultSeasonFor(episodes: SeriesEpisode[]): number | null {
  if (episodes.length === 0) return null;

  const availableSeasons = episodes
    .filter((episode) => episode.status.kind === 'Available')
    .map((episode) => episode.seasonNumber);
  if (availableSeasons.length > 0) return Math.min(...availableSeasons);

  return Math.min(...episodes.map((episode) => episode.seasonNumber));
}

export interface UseSeriesEpisodesResult {
  episodes: SeriesEpisode[];
  episodesBySeason: Map<number, SeriesEpisode[]>;
  seasons: number[];
  seriesProgress: number | null;
  defaultSeason: number | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * @param tmdbId series' TMDB id (the detail route's `:id`) - also the query key.
 * @param seriesJellyfinItemId the series-level Jellyfin item id (`TitleStatus.InLibrary.jellyfinItemId`), or `null` when not in the library - the query never fires without it.
 * @param tvdbId optional Sonarr-side fallback identity for series whose Jellyseerr media record carries a tvdbId but no tmdbId match in Sonarr.
 */
export function useSeriesEpisodes(
  tmdbId: string,
  seriesJellyfinItemId: string | null,
  tvdbId: number | null = null,
): UseSeriesEpisodesResult {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;
  const token = session?.jellyfinToken ?? null;

  const query = useQuery({
    queryKey: queryKeys.episodes(tmdbId),
    queryFn: async (): Promise<SeriesEpisode[]> => {
      const numericTmdbId = Number(tmdbId);
      const [jellyfin, sonarr] = await Promise.all([
        loadJellyfinEpisodes(userId as string, seriesJellyfinItemId as string, token),
        loadSonarrEpisodes(Number.isFinite(numericTmdbId) ? numericTmdbId : null, tvdbId),
      ]);
      return mergeEpisodes(jellyfin, sonarr.episodes, sonarr.percentByEpisodeId);
    },
    enabled: Boolean(userId && seriesJellyfinItemId),
  });

  const episodes = useMemo(() => query.data ?? [], [query.data]);
  const episodesBySeason = useMemo(() => groupBySeason(episodes), [episodes]);
  const seasons = useMemo(
    () => Array.from(episodesBySeason.keys()).sort((a, b) => a - b),
    [episodesBySeason],
  );
  const seriesProgress = useMemo(() => seriesCompleteness(episodes), [episodes]);
  const defaultSeason = useMemo(() => defaultSeasonFor(episodes), [episodes]);

  return {
    episodes,
    episodesBySeason,
    seasons,
    seriesProgress,
    defaultSeason,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
