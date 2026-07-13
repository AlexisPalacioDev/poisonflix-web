import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCancelDownload } from './useCancelDownload';
import {
  deleteRadarrQueueItem,
  deleteSonarrQueueItem,
  getRadarrMovieRaw,
  getRadarrMovies,
  getRadarrQueue,
  getSonarrEpisodes,
  getSonarrQueue,
  getSonarrSeries,
  putRadarrMovieRaw,
  putSonarrEpisodesMonitor,
} from '../api/arr';
import { deleteRequest } from '../api/jellyseerr';

vi.mock('../api/arr', () => ({
  getRadarrMovies: vi.fn(),
  getRadarrQueue: vi.fn(),
  deleteRadarrQueueItem: vi.fn(),
  getRadarrMovieRaw: vi.fn(),
  putRadarrMovieRaw: vi.fn(),
  getSonarrSeries: vi.fn(),
  getSonarrQueue: vi.fn(),
  deleteSonarrQueueItem: vi.fn(),
  getSonarrEpisodes: vi.fn(),
  putSonarrEpisodesMonitor: vi.fn(),
}));

vi.mock('../api/jellyseerr', () => ({
  deleteRequest: vi.fn(),
}));

const mockedGetRadarrMovies = vi.mocked(getRadarrMovies);
const mockedGetRadarrQueue = vi.mocked(getRadarrQueue);
const mockedDeleteRadarrQueueItem = vi.mocked(deleteRadarrQueueItem);
const mockedGetRadarrMovieRaw = vi.mocked(getRadarrMovieRaw);
const mockedPutRadarrMovieRaw = vi.mocked(putRadarrMovieRaw);
const mockedGetSonarrSeries = vi.mocked(getSonarrSeries);
const mockedGetSonarrQueue = vi.mocked(getSonarrQueue);
const mockedDeleteSonarrQueueItem = vi.mocked(deleteSonarrQueueItem);
const mockedGetSonarrEpisodes = vi.mocked(getSonarrEpisodes);
const mockedPutSonarrEpisodesMonitor = vi.mocked(putSonarrEpisodesMonitor);
const mockedDeleteRequest = vi.mocked(deleteRequest);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useCancelDownload (projector-feature-map.md §9 "Cancel flow")', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the 4-step best-effort order and calls deleteRequest last', async () => {
    mockedGetRadarrMovies.mockResolvedValue([{ id: 10, tmdbId: 603, monitored: true, hasFile: false, title: 'The Matrix' }]);
    mockedGetSonarrSeries.mockResolvedValue([]);
    mockedGetRadarrQueue.mockResolvedValue({ records: [{ id: 99, movieId: 10, size: 100, sizeleft: 50 }] });
    mockedDeleteRadarrQueueItem.mockResolvedValue(undefined);
    mockedGetRadarrMovieRaw.mockResolvedValue({ id: 10, monitored: true, title: 'The Matrix' });
    mockedPutRadarrMovieRaw.mockResolvedValue(undefined);
    mockedDeleteRequest.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: 603, requestId: 42 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Step 1: identity resolution.
    expect(mockedGetRadarrMovies).toHaveBeenCalled();
    expect(mockedGetSonarrSeries).toHaveBeenCalled();

    // Step 2: queue cancel - the matching Radarr queue record is deleted.
    expect(mockedGetRadarrQueue).toHaveBeenCalled();
    expect(mockedDeleteRadarrQueueItem).toHaveBeenCalledWith(99, true, false);

    // Step 3: unmonitor - full object round-trip with monitored:false.
    expect(mockedGetRadarrMovieRaw).toHaveBeenCalledWith(10);
    expect(mockedPutRadarrMovieRaw).toHaveBeenCalledWith(10, { id: 10, monitored: false, title: 'The Matrix' });

    // Step 4: the Jellyseerr request itself is dropped last.
    expect(mockedDeleteRequest).toHaveBeenCalledWith(42);

    const queueOrder = mockedDeleteRadarrQueueItem.mock.invocationCallOrder[0];
    const unmonitorOrder = mockedPutRadarrMovieRaw.mock.invocationCallOrder[0];
    const deleteRequestOrder = mockedDeleteRequest.mock.invocationCallOrder[0];
    expect(queueOrder).toBeLessThan(unmonitorOrder);
    expect(unmonitorOrder).toBeLessThan(deleteRequestOrder);
  });

  it('an empty/unreachable Radarr and Sonarr queue does NOT throw - still cancels the Jellyseerr request', async () => {
    mockedGetRadarrMovies.mockRejectedValue(new Error('401 Unauthorized'));
    mockedGetSonarrSeries.mockRejectedValue(new Error('401 Unauthorized'));
    mockedDeleteRequest.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: 603, requestId: 42 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isError).toBe(false);
    // Neither Radarr nor Sonarr identity resolved - queue/unmonitor calls never fire.
    expect(mockedGetRadarrQueue).not.toHaveBeenCalled();
    expect(mockedGetSonarrQueue).not.toHaveBeenCalled();
    // The request is still dropped from Jellyseerr regardless.
    expect(mockedDeleteRequest).toHaveBeenCalledWith(42);
  });

  it('unmonitors only pending (monitored && !hasFile) Sonarr episodes', async () => {
    mockedGetRadarrMovies.mockResolvedValue([]);
    mockedGetSonarrSeries.mockResolvedValue([{ id: 20, tvdbId: 1, tmdbId: 1399, title: 'Game of Thrones' }]);
    mockedGetSonarrQueue.mockResolvedValue({ records: [] });
    mockedGetSonarrEpisodes.mockResolvedValue([
      { id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: true, monitored: true, seriesId: 20 },
      { id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false, monitored: true, seriesId: 20 },
      { id: 3, seasonNumber: 1, episodeNumber: 3, hasFile: false, monitored: false, seriesId: 20 },
    ]);
    mockedPutSonarrEpisodesMonitor.mockResolvedValue(undefined);
    mockedDeleteRequest.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: 1399, requestId: 7 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // No queue records for this series - deleteSonarrQueueItem is never called.
    expect(mockedDeleteSonarrQueueItem).not.toHaveBeenCalled();
    expect(mockedPutSonarrEpisodesMonitor).toHaveBeenCalledWith([2], false);
    expect(mockedDeleteRequest).toHaveBeenCalledWith(7);
  });

  it('propagates a failure to actually delete the Jellyseerr request (the one non-best-effort step)', async () => {
    mockedGetRadarrMovies.mockResolvedValue([]);
    mockedGetSonarrSeries.mockResolvedValue([]);
    mockedDeleteRequest.mockRejectedValue(new Error('404 request not found'));

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: 603, requestId: 42 });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
