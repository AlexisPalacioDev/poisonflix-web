import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSeasonFor,
  groupBySeason,
  mergeEpisodes,
  progressOf,
  queueInfoFromRecord,
  useSeriesEpisodes,
  type EpisodeQueueInfo,
  type SeriesEpisode,
} from './useSeriesEpisodes';
import type { ArrQueueRecord } from '../api/schemas/arr';
import { AuthProvider } from '../auth/AuthContext';
import { clearSession, setSession } from '../lib/session/store';
import { getItems } from '../api/jellyfin';
import { getSonarrEpisodes, getSonarrQueue, getSonarrSeries } from '../api/arr';

// Episode-browsing (projector-feature-map.md §7 "TV SERIES layout", walkthrough
// §19/§20), ported from `EpisodeRepositoryImpl.kt`. Jellyfin is the
// E2E-verifiable path (the PLAYABLE truth); Sonarr 401s without a provisioned
// API key in this dev environment - every scenario below that touches Sonarr
// asserts the graceful-degradation contract instead of a live 200 response.
//
// Honesty rework (owner's live Bleach repro): a Sonarr queue record with
// `status: "completed"`/`sizeleft: 0` is DONE transferring but not yet moved
// into the library by Sonarr's own import pipeline - showing "En cola" or a
// stuck percent for it is a lie either way. `queueInfoFromRecord` resolves
// the record's REAL phase instead of assuming "downloading" from bare
// presence; the tests below assert every phase it can produce, plus the
// warning surfacing and the `NotMonitored` silence for an episode Sonarr
// itself has given up on.

vi.mock('../api/jellyfin', () => ({ getItems: vi.fn() }));
vi.mock('../api/arr', () => ({
  getSonarrSeries: vi.fn(),
  getSonarrEpisodes: vi.fn(),
  getSonarrQueue: vi.fn(),
}));

const mockedGetItems = vi.mocked(getItems);
const mockedGetSonarrSeries = vi.mocked(getSonarrSeries);
const mockedGetSonarrEpisodes = vi.mocked(getSonarrEpisodes);
const mockedGetSonarrQueue = vi.mocked(getSonarrQueue);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: queryClient }, createElement(AuthProvider, null, children));
}

function available(jellyfinItemId: string): SeriesEpisode['status'] {
  return { kind: 'Available', jellyfinItemId };
}

/** Builds a full `SeriesEpisode`, defaulting the fields every test doesn't care about - keeps each test's literal focused on what it's actually asserting. */
function episode(overrides: Partial<SeriesEpisode> & Pick<SeriesEpisode, 'seasonNumber' | 'episodeNumber' | 'title' | 'status'>): SeriesEpisode {
  return { overview: null, stillUrl: null, mediaStreams: null, ...overrides };
}

/** Builds a full `ArrQueueRecord`, defaulting the fields every test doesn't care about. */
function queueRecord(overrides: Partial<ArrQueueRecord>): ArrQueueRecord {
  return {
    id: 1,
    size: 0,
    sizeleft: 0,
    status: null,
    title: null,
    trackedDownloadState: null,
    trackedDownloadStatus: null,
    errorMessage: null,
    movieId: null,
    seriesId: null,
    episodeId: null,
    ...overrides,
  };
}

describe('useSeriesEpisodes (episode-browsing, projector-feature-map.md §7)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedGetSonarrSeries.mockReset();
    mockedGetSonarrEpisodes.mockReset();
    mockedGetSonarrQueue.mockReset();
  });

  it('merges Jellyfin (Available) with Sonarr (Missing/Downloading) episodes, grouped and sorted by season/episode', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({
      Items: [
        { Id: 'ep-1', Name: 'Pilot', IndexNumber: 1, ParentIndexNumber: 1, SeriesId: 'jf-series' },
        { Id: 'ep-2', Name: 'Episode 2', IndexNumber: 2, ParentIndexNumber: 1, SeriesId: 'jf-series' },
      ],
      TotalRecordCount: 2,
      StartIndex: 0,
    } as never);
    mockedGetSonarrSeries.mockResolvedValue([{ id: 20, tmdbId: 1399, tvdbId: 121361, title: 'Series' }] as never);
    mockedGetSonarrEpisodes.mockResolvedValue([
      { id: 100, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', hasFile: true, monitored: true, seriesId: 20 },
      { id: 101, seasonNumber: 1, episodeNumber: 2, title: 'Episode 2', hasFile: false, monitored: true, seriesId: 20 },
      { id: 102, seasonNumber: 1, episodeNumber: 3, title: 'Episode 3', hasFile: false, monitored: true, seriesId: 20 },
    ] as never);
    mockedGetSonarrQueue.mockResolvedValue({
      records: [
        queueRecord({ id: 999, seriesId: 20, episodeId: 102, size: 100, sizeleft: 40, status: 'downloading' }),
      ],
    } as never);

    const { result } = renderHook(() => useSeriesEpisodes('1399', 'jf-series'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.episodes).toEqual([
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', status: available('ep-1') }),
      episode({ seasonNumber: 1, episodeNumber: 2, title: 'Episode 2', status: available('ep-2') }),
      episode({
        seasonNumber: 1,
        episodeNumber: 3,
        title: 'Episode 3',
        status: { kind: 'Downloading', percent: 60, warning: null },
      }),
    ]);
    expect(result.current.seasons).toEqual([1]);
    expect(result.current.episodesBySeason.get(1)).toHaveLength(3);
    // Jellyfin's own PLAYABLE truth wins over Sonarr for episode 2 - even
    // though Sonarr also lists it (hasFile: false there), Jellyfin already
    // has it, so it must read Available, never Missing/Downloading.
    expect(mockedGetSonarrSeries).toHaveBeenCalled();
  });

  it('a Sonarr queue record done transferring but not yet imported reads Importing, never "En cola" (owner\'s live Bleach repro: episodeId 1015, sizeleft 0, status completed)', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedGetSonarrSeries.mockResolvedValue([{ id: 12, tmdbId: 1399, tvdbId: null, title: 'Bleach' }] as never);
    mockedGetSonarrEpisodes.mockResolvedValue([
      { id: 1015, seasonNumber: 2, episodeNumber: 1, title: 'Ep 1', hasFile: false, monitored: true, seriesId: 12 },
    ] as never);
    mockedGetSonarrQueue.mockResolvedValue({
      records: [queueRecord({ id: 1, seriesId: 12, episodeId: 1015, size: 500, sizeleft: 0, status: 'completed' })],
    } as never);

    const { result } = renderHook(() => useSeriesEpisodes('1399', 'jf-series'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.episodes).toEqual([
      episode({
        seasonNumber: 2,
        episodeNumber: 1,
        title: 'Ep 1',
        status: { kind: 'Importing', warning: null },
      }),
    ]);
  });

  it('an episode Sonarr itself has stopped monitoring reads NotMonitored, not Missing - nothing is going to fetch it', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedGetSonarrSeries.mockResolvedValue([{ id: 12, tmdbId: 1399, tvdbId: null, title: 'Bleach' }] as never);
    mockedGetSonarrEpisodes.mockResolvedValue([
      { id: 5, seasonNumber: 1, episodeNumber: 1, title: 'Filler', hasFile: false, monitored: false, seriesId: 12 },
    ] as never);
    mockedGetSonarrQueue.mockResolvedValue({ records: [] } as never);

    const { result } = renderHook(() => useSeriesEpisodes('1399', 'jf-series'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.episodes).toEqual([
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'Filler', status: { kind: 'NotMonitored' } }),
    ]);
  });

  it('a Sonarr 401/outage degrades to Jellyfin-only episodes (no Missing/Downloading rows), no throw', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'ep-1', Name: 'Pilot', IndexNumber: 1, ParentIndexNumber: 1, SeriesId: 'jf-series' }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetSonarrSeries.mockRejectedValue(new Error('401 Unauthorized'));

    const { result } = renderHook(() => useSeriesEpisodes('1399', 'jf-series'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isError).toBe(false);
    expect(result.current.episodes).toEqual([
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', status: available('ep-1') }),
    ]);
    expect(mockedGetSonarrEpisodes).not.toHaveBeenCalled();
  });

  it('a Sonarr queue failure still returns the full episode list (everything not in Jellyfin reads Missing)', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    mockedGetSonarrSeries.mockResolvedValue([{ id: 20, tmdbId: 1399, tvdbId: null, title: 'Series' }] as never);
    mockedGetSonarrEpisodes.mockResolvedValue([
      { id: 100, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', hasFile: false, monitored: true, seriesId: 20 },
    ] as never);
    mockedGetSonarrQueue.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useSeriesEpisodes('1399', 'jf-series'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.episodes).toEqual([
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', status: { kind: 'Missing' } }),
    ]);
  });

  it('never fires without a series Jellyfin item id (not InLibrary yet)', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });

    const { result } = renderHook(() => useSeriesEpisodes('1399', null), { wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.episodes).toEqual([]);
    expect(mockedGetItems).not.toHaveBeenCalled();
  });
});

describe('queueInfoFromRecord (Sonarr queue-record honesty, owner\'s "En cola"/"Descargando" repro)', () => {
  it('an actively transferring record reads downloading, with its real percent', () => {
    const info = queueInfoFromRecord(queueRecord({ status: 'downloading', size: 100, sizeleft: 25 }));
    expect(info).toEqual<EpisodeQueueInfo>({ phase: 'downloading', percent: 75, warning: null });
  });

  it('status "completed" reads importing, never downloading/queued, even mid-percent fields', () => {
    const info = queueInfoFromRecord(queueRecord({ status: 'completed', size: 500, sizeleft: 0 }));
    expect(info.phase).toBe('importing');
  });

  it('trackedDownloadState in Sonarr\'s own import pipeline reads importing regardless of client status', () => {
    for (const trackedDownloadState of ['importPending', 'importing', 'imported']) {
      const info = queueInfoFromRecord(queueRecord({ status: 'downloading', trackedDownloadState, size: 100, sizeleft: 100 }));
      expect(info.phase).toBe('importing');
    }
  });

  it('sizeleft reaching 0 with a known size reads importing even if the client never reported "completed"', () => {
    const info = queueInfoFromRecord(queueRecord({ status: 'paused', size: 200, sizeleft: 0 }));
    expect(info.phase).toBe('importing');
  });

  it('anything else (queued/paused/delay/unknown, not started, not done) reads queued - the ONLY phase "En cola" may honestly describe', () => {
    for (const status of ['queued', 'paused', 'delay', null]) {
      const info = queueInfoFromRecord(queueRecord({ status, size: 100, sizeleft: 100 }));
      expect(info.phase).toBe('queued');
    }
  });

  it('surfaces errorMessage as the warning verbatim', () => {
    const info = queueInfoFromRecord(queueRecord({ errorMessage: 'no files found are eligible for import' }));
    expect(info.warning).toBe('no files found are eligible for import');
  });

  it('surfaces trackedDownloadStatus warning/error even without an errorMessage', () => {
    expect(queueInfoFromRecord(queueRecord({ trackedDownloadStatus: 'warning' })).warning).toBe(
      'La descarga necesita atención en Sonarr.',
    );
    expect(queueInfoFromRecord(queueRecord({ trackedDownloadStatus: 'error' })).warning).toBe('La descarga falló.');
  });

  it('a clean transfer carries no warning', () => {
    expect(queueInfoFromRecord(queueRecord({ status: 'downloading', trackedDownloadStatus: 'ok' })).warning).toBeNull();
  });
});

describe('mergeEpisodes / groupBySeason / progressOf / defaultSeasonFor (pure status derivation)', () => {
  it('hides season 0 "specials" unless Jellyfin actually has the file', () => {
    const jellyfin = new Map([
      ['0:1', { jellyfinItemId: 'ep-special', title: 'Special', overview: null, stillUrl: null, mediaStreams: null }],
    ]);
    const sonarrOnly = [{ id: 1, seasonNumber: 0, episodeNumber: 2, title: 'Hidden special', hasFile: false, monitored: true, seriesId: 1 }] as never;

    const episodes = mergeEpisodes(jellyfin, sonarrOnly, new Map());

    expect(episodes).toEqual([
      episode({ seasonNumber: 0, episodeNumber: 1, title: 'Special', status: available('ep-special') }),
    ]);
  });

  it('falls back to a generic "Episodio N" title when neither source names the episode', () => {
    const sonarrOnly = [
      { id: 1, seasonNumber: 1, episodeNumber: 5, title: null, hasFile: false, monitored: true, seriesId: 1 },
    ] as never;

    const episodes = mergeEpisodes(new Map(), sonarrOnly, new Map());

    expect(episodes[0]).toMatchObject({ title: 'Episodio 5', status: { kind: 'Missing' } });
  });

  it('resolves Downloading/Importing/Queued from a matching queue record, by Sonarr episode id', () => {
    const sonarrOnly = [
      { id: 10, seasonNumber: 1, episodeNumber: 1, title: 'Downloading ep', hasFile: false, monitored: true, seriesId: 1 },
      { id: 11, seasonNumber: 1, episodeNumber: 2, title: 'Importing ep', hasFile: false, monitored: true, seriesId: 1 },
      { id: 12, seasonNumber: 1, episodeNumber: 3, title: 'Queued ep', hasFile: false, monitored: true, seriesId: 1 },
    ] as never;
    const queueInfoByEpisodeId = new Map<number, EpisodeQueueInfo>([
      [10, { phase: 'downloading', percent: 40, warning: null }],
      [11, { phase: 'importing', percent: null, warning: 'no files found are eligible for import' }],
      [12, { phase: 'queued', percent: null, warning: null }],
    ]);

    const episodes = mergeEpisodes(new Map(), sonarrOnly, queueInfoByEpisodeId);

    expect(episodes.map((e) => e.status)).toEqual([
      { kind: 'Downloading', percent: 40, warning: null },
      { kind: 'Importing', warning: 'no files found are eligible for import' },
      { kind: 'Queued', warning: null },
    ]);
  });

  it('groupBySeason preserves episode order within each season and covers multiple seasons (walkthrough §20)', () => {
    const episodes: SeriesEpisode[] = [
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'S1E1', status: available('a') }),
      episode({ seasonNumber: 1, episodeNumber: 2, title: 'S1E2', status: available('b') }),
      episode({ seasonNumber: 2, episodeNumber: 1, title: 'S2E1', status: available('c') }),
    ];

    const bySeason = groupBySeason(episodes);

    expect(Array.from(bySeason.keys())).toEqual([1, 2]);
    expect(bySeason.get(1)?.map((e) => e.title)).toEqual(['S1E1', 'S1E2']);
    expect(bySeason.get(2)?.map((e) => e.title)).toEqual(['S2E1']);
  });

  it('progressOf keeps completeness (available/total) separate from activity (downloading/importing/queued), and counts warnings', () => {
    const episodes: SeriesEpisode[] = [
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'a', status: available('a') }),
      episode({ seasonNumber: 1, episodeNumber: 2, title: 'b', status: { kind: 'Downloading', percent: 50, warning: null } }),
      episode({
        seasonNumber: 1,
        episodeNumber: 3,
        title: 'c',
        status: { kind: 'Importing', warning: 'no files found are eligible for import' },
      }),
      episode({ seasonNumber: 1, episodeNumber: 4, title: 'd', status: { kind: 'Queued', warning: null } }),
      episode({ seasonNumber: 1, episodeNumber: 5, title: 'e', status: { kind: 'Missing' } }),
      episode({ seasonNumber: 1, episodeNumber: 6, title: 'f', status: { kind: 'NotMonitored' } }),
    ];

    expect(progressOf(episodes)).toEqual({
      availableCount: 1,
      totalCount: 6,
      downloadingCount: 1,
      importingCount: 1,
      queuedCount: 1,
      warningCount: 1,
    });
  });

  it('progressOf on an empty list returns all-zero counts, never throws', () => {
    expect(progressOf([])).toEqual({
      availableCount: 0,
      totalCount: 0,
      downloadingCount: 0,
      importingCount: 0,
      queuedCount: 0,
      warningCount: 0,
    });
  });

  it('defaultSeasonFor picks the lowest season with an Available episode, else the lowest season overall', () => {
    const noneAvailable: SeriesEpisode[] = [
      episode({ seasonNumber: 2, episodeNumber: 1, title: 'a', status: { kind: 'Missing' } }),
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'b', status: { kind: 'Missing' } }),
    ];
    expect(defaultSeasonFor(noneAvailable)).toBe(1);

    const season3Available: SeriesEpisode[] = [
      episode({ seasonNumber: 1, episodeNumber: 1, title: 'a', status: { kind: 'Missing' } }),
      episode({ seasonNumber: 2, episodeNumber: 1, title: 'b', status: { kind: 'Missing' } }),
      episode({ seasonNumber: 3, episodeNumber: 1, title: 'c', status: available('c') }),
    ];
    expect(defaultSeasonFor(season3Available)).toBe(3);

    expect(defaultSeasonFor([])).toBeNull();
  });
});
