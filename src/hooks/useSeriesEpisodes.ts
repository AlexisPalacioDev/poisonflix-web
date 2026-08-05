import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import { getSonarrEpisodes, getSonarrQueue, getSonarrSeries } from '../api/arr';
import type { ArrQueueRecord, SonarrEpisode } from '../api/schemas/arr';
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
// not-yet-downloaded episodes still show up instead of vanishing) plus each
// queue record's real per-episode phase/percent/health.
//
// Honesty rework (owner's live Bleach repro: Season 2 all read "En cola"
// while Sonarr's own queue held a single COMPLETED record and nothing else -
// the app was inventing activity that wasn't happening): a Sonarr queue
// record no longer collapses to one bare percent. `queueInfoFromRecord`
// below reads `trackedDownloadState`/`status`/`sizeleft` to tell apart three
// genuinely different situations a queue entry can be in - actively
// transferring bytes (`Downloading`), done transferring but not yet moved
// into the library (`Importing`), and sitting in the client not started yet
// (`Queued`) - and `errorMessage`/`trackedDownloadStatus` surface a stuck
// transfer instead of hiding it. An episode with NO queue record at all is
// `Missing` (nothing incoming) unless Sonarr itself isn't even looking for it
// (`monitored: false`), which is `NotMonitored` - a different, more honest
// silence.
//
// Sonarr 401s without a provisioned API key in this dev environment (task
// constraint - same as `useCancelDownload`'s Radarr/Sonarr steps): every
// Sonarr call below is independently try/caught, so a 401/outage degrades to
// Jellyfin-only episodes (no Missing/Downloading/etc. rows, no crash) rather
// than blanking the whole two-pane layout. Jellyfin failures are caught the
// same way, for the same reason.

export type EpisodeStatus =
  | { kind: 'Available'; jellyfinItemId: string }
  | { kind: 'Downloading'; percent: number; warning: string | null }
  | { kind: 'Importing'; warning: string | null }
  | { kind: 'Queued'; warning: string | null }
  | { kind: 'Missing' }
  | { kind: 'NotMonitored' };

export interface SeriesEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string | null;
  stillUrl: string | null;
  status: EpisodeStatus;
  // The episode's own raw Jellyfin `MediaStreams` (audio/subtitle tracks),
  // for the media-languages panel's per-series aggregation
  // (`seriesLanguages.ts`) - `null` for anything not `Available` (Sonarr
  // never carries stream data, only Jellyfin does once the file is in the
  // library).
  mediaStreams: unknown[] | null;
}

interface JellyfinEpisodeInfo {
  jellyfinItemId: string;
  title: string | null;
  overview: string | null;
  stillUrl: string | null;
  mediaStreams: unknown[] | null;
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
      // `MediaStreams` added (owner ask #4 / Bleach repro): the media-languages
      // panel used to resolve only the FIRST available episode's item via a
      // second `getItem` call and present ITS languages as the whole series'.
      // Every episode's item already flows through this single bulk fetch, so
      // asking for MediaStreams here gets every episode's real audio/subtitle
      // tracks for free - no N+1 fetch needed.
      fields: 'Overview,ProviderIds,ImageTags,MediaStreams',
    });
    for (const item of result.Items) {
      if (item.IndexNumber == null) continue;
      const season = item.ParentIndexNumber ?? 0;
      map.set(episodeKey(season, item.IndexNumber), {
        jellyfinItemId: item.Id,
        title: item.Name,
        overview: item.Overview ?? null,
        stillUrl: jellyfinPosterUrl(item, token),
        mediaStreams: item.MediaStreams ?? null,
      });
    }
  } catch {
    // Best-effort - an unreachable Jellyfin episode list must not crash the
    // whole two-pane layout; the caller still gets Sonarr's rows, if any.
  }
  return map;
}

/** A queue record's meaning, resolved from Sonarr's own fields rather than assumed from bare presence. */
export interface EpisodeQueueInfo {
  phase: 'downloading' | 'importing' | 'queued';
  percent: number | null;
  warning: string | null;
}

/** Download completion 0..100, or null if the total size is unknown - same rule as `lib/domain/downloadProgress.ts`'s `percentOf` (not exported from there, so intentionally duplicated here; both are ~5 lines). */
function queuePercent(size: number, sizeleft: number): number | null {
  if (size <= 0) return null;
  return Math.min(100, Math.max(0, ((size - sizeleft) / size) * 100));
}

const IMPORT_PIPELINE_STATES = new Set(['importPending', 'importing', 'imported']);

/** A record's own health message, or `null` on a clean transfer - never invented, only Sonarr's own `errorMessage`/`trackedDownloadStatus`. */
function warningOf(record: ArrQueueRecord): string | null {
  if (record.errorMessage) return record.errorMessage;
  if (record.trackedDownloadStatus === 'warning') return 'La descarga necesita atención en Sonarr.';
  if (record.trackedDownloadStatus === 'error') return 'La descarga falló.';
  return null;
}

/**
 * Resolves what a Sonarr queue record actually means, instead of collapsing
 * every record to "downloading N%" (the owner's Bleach repro: a record with
 * `sizeleft: 0, status: "completed"` is DONE transferring, waiting on
 * Sonarr's import step - showing "En cola" or a stuck percent for it is a
 * lie either way).
 *
 * - `importing`: Sonarr's own post-download pipeline (`trackedDownloadState`
 *   in importPending/importing/imported) hasn't finished, OR the transfer
 *   itself reports done (`status: "completed"`, or `sizeleft <= 0` with a
 *   known `size`) but Jellyfin doesn't have the file yet.
 * - `downloading`: the client itself reports actively transferring.
 * - `queued`: anything else (queued/paused/delay/unknown status) - waiting
 *   its turn, not moving yet. This is the ONLY phase "En cola" may honestly
 *   describe.
 */
export function queueInfoFromRecord(record: ArrQueueRecord): EpisodeQueueInfo {
  const percent = queuePercent(record.size, record.sizeleft);
  const isImporting =
    (record.trackedDownloadState != null && IMPORT_PIPELINE_STATES.has(record.trackedDownloadState)) ||
    record.status === 'completed' ||
    (record.size > 0 && record.sizeleft <= 0);

  const phase: EpisodeQueueInfo['phase'] = isImporting
    ? 'importing'
    : record.status === 'downloading'
      ? 'downloading'
      : 'queued';

  return { phase, percent, warning: warningOf(record) };
}

function statusFromQueueInfo(info: EpisodeQueueInfo): EpisodeStatus {
  switch (info.phase) {
    case 'downloading':
      return { kind: 'Downloading', percent: info.percent ?? 0, warning: info.warning };
    case 'importing':
      return { kind: 'Importing', warning: info.warning };
    case 'queued':
      return { kind: 'Queued', warning: info.warning };
  }
}

interface SonarrLoadResult {
  episodes: SonarrEpisode[];
  queueInfoByEpisodeId: Map<number, EpisodeQueueInfo>;
}

/** Sonarr's full episode list + a queue-derived status map, matched by tmdbId or (fallback) tvdbId. Every step is independently best-effort. */
async function loadSonarrEpisodes(tmdbId: number | null, tvdbId: number | null): Promise<SonarrLoadResult> {
  const empty: SonarrLoadResult = { episodes: [], queueInfoByEpisodeId: new Map() };
  if (tmdbId == null && tvdbId == null) return empty;

  try {
    const seriesList = await getSonarrSeries();
    const series = seriesList.find(
      (s) => (tmdbId != null && s.tmdbId === tmdbId) || (tvdbId != null && s.tvdbId === tvdbId),
    );
    if (!series) return empty;

    const episodes = await getSonarrEpisodes(series.id);

    const queueInfoByEpisodeId = new Map<number, EpisodeQueueInfo>();
    try {
      const queue = await getSonarrQueue(true);
      for (const record of queue.records) {
        if (record.seriesId !== series.id || record.episodeId == null) continue;
        queueInfoByEpisodeId.set(record.episodeId, queueInfoFromRecord(record));
      }
    } catch {
      // Best-effort - an unreachable queue still leaves the full episode list.
    }

    return { episodes, queueInfoByEpisodeId };
  } catch {
    // Sonarr 401s without an API key in this dev env - degrade to
    // Jellyfin-only (no Missing/Downloading/etc. rows), no crash.
    return empty;
  }
}

/**
 * Merges Jellyfin's playable episodes with Sonarr's full list + queue status,
 * keyed by (season, episode). Jellyfin presence wins (`Available`); else a
 * matching Sonarr queue record resolves to `Downloading`/`Importing`/`Queued`
 * (never invented - see `queueInfoFromRecord`); else `Missing` when Sonarr is
 * still tracking the episode, or `NotMonitored` when Sonarr has explicitly
 * given up on it (`monitored: false` - nothing is going to fetch it). Season
 * 0 "specials" are hidden UNLESS Jellyfin actually has the file (a playable
 * special must never be hidden).
 */
export function mergeEpisodes(
  jellyfin: Map<string, JellyfinEpisodeInfo>,
  sonarrEpisodes: SonarrEpisode[],
  queueInfoByEpisodeId: Map<number, EpisodeQueueInfo>,
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
    const queueInfo = sonarr ? queueInfoByEpisodeId.get(sonarr.id) : undefined;
    const status: EpisodeStatus = jf
      ? { kind: 'Available', jellyfinItemId: jf.jellyfinItemId }
      : queueInfo
        ? statusFromQueueInfo(queueInfo)
        : sonarr?.monitored === false
          ? { kind: 'NotMonitored' }
          : { kind: 'Missing' };

    episodes.push({
      seasonNumber,
      episodeNumber,
      title: jf?.title ?? sonarr?.title ?? `Episodio ${episodeNumber}`,
      overview: jf?.overview ?? null,
      stillUrl: jf?.stillUrl ?? null,
      status,
      mediaStreams: jf?.mediaStreams ?? null,
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
 * Honest progress over a set of episodes - a whole series, or one season's
 * subset (same shape, same function; `SeriesTwoPane` applies it at both
 * levels). Deliberately keeps "how much do I HAVE" (`availableCount` /
 * `totalCount`) separate from "how much is currently HAPPENING"
 * (`downloadingCount` / `importingCount` / `queuedCount`) - the owner's
 * second complaint was these two different questions being fused into one
 * "Descargando · N%" bar that kept reading a stale completeness percentage
 * under an activity label, showing movement that had already stopped.
 * `warningCount` surfaces stuck/broken transfers that were previously
 * invisible (an item wedged in Sonarr's import pipeline for hours read as
 * plain "En cola" before this rework).
 */
export interface EpisodeProgress {
  availableCount: number;
  totalCount: number;
  downloadingCount: number;
  importingCount: number;
  queuedCount: number;
  warningCount: number;
}

export function progressOf(episodes: SeriesEpisode[]): EpisodeProgress {
  const progress: EpisodeProgress = {
    availableCount: 0,
    totalCount: episodes.length,
    downloadingCount: 0,
    importingCount: 0,
    queuedCount: 0,
    warningCount: 0,
  };

  for (const { status } of episodes) {
    switch (status.kind) {
      case 'Available':
        progress.availableCount += 1;
        break;
      case 'Downloading':
        progress.downloadingCount += 1;
        if (status.warning) progress.warningCount += 1;
        break;
      case 'Importing':
        progress.importingCount += 1;
        if (status.warning) progress.warningCount += 1;
        break;
      case 'Queued':
        progress.queuedCount += 1;
        if (status.warning) progress.warningCount += 1;
        break;
      case 'Missing':
      case 'NotMonitored':
        break;
    }
  }

  return progress;
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
  seriesProgress: EpisodeProgress;
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
      return mergeEpisodes(jellyfin, sonarr.episodes, sonarr.queueInfoByEpisodeId);
    },
    enabled: Boolean(userId && seriesJellyfinItemId),
    // Live-refresh per-episode status (queued/downloading/importing/available)
    // on the detail page. Without this the episode list was fetched once on
    // mount and froze, so a completed download kept showing a stale status
    // until a manual reload.
    staleTime: 8_000,
    refetchInterval: 15_000,
  });

  const episodes = useMemo(() => query.data ?? [], [query.data]);
  const episodesBySeason = useMemo(() => groupBySeason(episodes), [episodes]);
  const seasons = useMemo(
    () => Array.from(episodesBySeason.keys()).sort((a, b) => a - b),
    [episodesBySeason],
  );
  const seriesProgress = useMemo(() => progressOf(episodes), [episodes]);
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
