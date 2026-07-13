import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSeasonFor,
  groupBySeason,
  mergeEpisodes,
  seriesCompleteness,
  useSeriesEpisodes,
  type SeriesEpisode,
} from './useSeriesEpisodes';
import { AuthProvider } from '../auth/AuthContext';
import { clearSession, setSession } from '../lib/session/store';
import { getItems } from '../api/jellyfin';
import { getSonarrEpisodes, getSonarrQueue, getSonarrSeries } from '../api/arr';

// Episode-browsing (projector-feature-map.md §7 "TV SERIES layout", walkthrough
// §19/§20), ported from `EpisodeRepositoryImpl.kt`. Jellyfin is the
// E2E-verifiable path (the PLAYABLE truth); Sonarr 401s without a provisioned
// API key in this dev environment - every scenario below that touches Sonarr
// asserts the graceful-degradation contract instead of a live 200 response.

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
      records: [{ id: 999, seriesId: 20, episodeId: 102, size: 100, sizeleft: 40 }],
    } as never);

    const { result } = renderHook(() => useSeriesEpisodes('1399', 'jf-series'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.episodes).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', overview: null, stillUrl: null, status: available('ep-1') },
      {
        seasonNumber: 1,
        episodeNumber: 2,
        title: 'Episode 2',
        overview: null,
        stillUrl: null,
        status: available('ep-2'),
      },
      {
        seasonNumber: 1,
        episodeNumber: 3,
        title: 'Episode 3',
        overview: null,
        stillUrl: null,
        status: { kind: 'Downloading', percent: 60 },
      },
    ]);
    expect(result.current.seasons).toEqual([1]);
    expect(result.current.episodesBySeason.get(1)).toHaveLength(3);
    // Jellyfin's own PLAYABLE truth wins over Sonarr for episode 2 - even
    // though Sonarr also lists it (hasFile: false there), Jellyfin already
    // has it, so it must read Available, never Missing/Downloading.
    expect(mockedGetSonarrSeries).toHaveBeenCalled();
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
      { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', overview: null, stillUrl: null, status: available('ep-1') },
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
      { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', overview: null, stillUrl: null, status: { kind: 'Missing' } },
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

describe('mergeEpisodes / groupBySeason / seriesCompleteness / defaultSeasonFor (pure status derivation)', () => {
  it('hides season 0 "specials" unless Jellyfin actually has the file', () => {
    const jellyfin = new Map([['0:1', { jellyfinItemId: 'ep-special', title: 'Special', overview: null, stillUrl: null }]]);
    const sonarrOnly = [{ id: 1, seasonNumber: 0, episodeNumber: 2, title: 'Hidden special', hasFile: false, monitored: true, seriesId: 1 }] as never;

    const episodes = mergeEpisodes(jellyfin, sonarrOnly, new Map());

    expect(episodes).toEqual([
      { seasonNumber: 0, episodeNumber: 1, title: 'Special', overview: null, stillUrl: null, status: available('ep-special') },
    ]);
  });

  it('falls back to a generic "Episodio N" title when neither source names the episode', () => {
    const sonarrOnly = [
      { id: 1, seasonNumber: 1, episodeNumber: 5, title: null, hasFile: false, monitored: true, seriesId: 1 },
    ] as never;

    const episodes = mergeEpisodes(new Map(), sonarrOnly, new Map());

    expect(episodes[0]).toMatchObject({ title: 'Episodio 5', status: { kind: 'Missing' } });
  });

  it('groupBySeason preserves episode order within each season and covers multiple seasons (walkthrough §20)', () => {
    const episodes: SeriesEpisode[] = [
      { seasonNumber: 1, episodeNumber: 1, title: 'S1E1', overview: null, stillUrl: null, status: available('a') },
      { seasonNumber: 1, episodeNumber: 2, title: 'S1E2', overview: null, stillUrl: null, status: available('b') },
      { seasonNumber: 2, episodeNumber: 1, title: 'S2E1', overview: null, stillUrl: null, status: available('c') },
    ];

    const bySeason = groupBySeason(episodes);

    expect(Array.from(bySeason.keys())).toEqual([1, 2]);
    expect(bySeason.get(1)?.map((e) => e.title)).toEqual(['S1E1', 'S1E2']);
    expect(bySeason.get(2)?.map((e) => e.title)).toEqual(['S2E1']);
  });

  it('seriesCompleteness averages readiness across all episodes and returns null once fully available', () => {
    const partial: SeriesEpisode[] = [
      { seasonNumber: 1, episodeNumber: 1, title: 'a', overview: null, stillUrl: null, status: available('a') },
      {
        seasonNumber: 1,
        episodeNumber: 2,
        title: 'b',
        overview: null,
        stillUrl: null,
        status: { kind: 'Downloading', percent: 50 },
      },
      { seasonNumber: 1, episodeNumber: 3, title: 'c', overview: null, stillUrl: null, status: { kind: 'Missing' } },
    ];
    // (1 + 0.5 + 0) / 3 = 50%.
    expect(seriesCompleteness(partial)).toBe(50);

    const fullyAvailable: SeriesEpisode[] = [
      { seasonNumber: 1, episodeNumber: 1, title: 'a', overview: null, stillUrl: null, status: available('a') },
    ];
    expect(seriesCompleteness(fullyAvailable)).toBeNull();
    expect(seriesCompleteness([])).toBeNull();
  });

  it('defaultSeasonFor picks the lowest season with an Available episode, else the lowest season overall', () => {
    const noneAvailable: SeriesEpisode[] = [
      { seasonNumber: 2, episodeNumber: 1, title: 'a', overview: null, stillUrl: null, status: { kind: 'Missing' } },
      { seasonNumber: 1, episodeNumber: 1, title: 'b', overview: null, stillUrl: null, status: { kind: 'Missing' } },
    ];
    expect(defaultSeasonFor(noneAvailable)).toBe(1);

    const season3Available: SeriesEpisode[] = [
      { seasonNumber: 1, episodeNumber: 1, title: 'a', overview: null, stillUrl: null, status: { kind: 'Missing' } },
      { seasonNumber: 2, episodeNumber: 1, title: 'b', overview: null, stillUrl: null, status: { kind: 'Missing' } },
      { seasonNumber: 3, episodeNumber: 1, title: 'c', overview: null, stillUrl: null, status: available('c') },
    ];
    expect(defaultSeasonFor(season3Available)).toBe(3);

    expect(defaultSeasonFor([])).toBeNull();
  });
});
