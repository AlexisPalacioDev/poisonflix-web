import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/http/client';
import { deleteRadarrMovie, deleteRadarrQueueItem, getSonarrQueue, putSonarrEpisodesMonitor } from './arr';

// Asserts arr.ts hits the exact Radarr/Sonarr v3 paths + methods + query
// params ArrApi.kt does, going through the same `apiFetch('radarr' | 'sonarr', ...)`
// seam as every other backend - no ad-hoc `fetch()` calls, no client-side
// X-Api-Key (the proxy injects it server-side).

vi.mock('../lib/http/client', () => ({
  apiFetch: vi.fn().mockResolvedValue(undefined),
}));

const mockedApiFetch = vi.mocked(apiFetch);

describe('arr.ts path/method wiring', () => {
  it('deleteRadarrMovie hits DELETE api/v3/movie/{id}?deleteFiles=true by default', async () => {
    await deleteRadarrMovie(42);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'radarr',
      '/api/v3/movie/42?deleteFiles=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteRadarrMovie honors deleteFiles=false', async () => {
    await deleteRadarrMovie(42, false);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'radarr',
      '/api/v3/movie/42?deleteFiles=false',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteRadarrQueueItem hits DELETE api/v3/queue/{id} with removeFromClient/blocklist query params', async () => {
    await deleteRadarrQueueItem(7);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'radarr',
      '/api/v3/queue/7?removeFromClient=true&blocklist=false',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('getSonarrQueue defaults includeEpisode to false', async () => {
    await getSonarrQueue();

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'sonarr',
      '/api/v3/queue?includeEpisode=false',
      expect.objectContaining({ schema: expect.anything() }),
    );
  });

  it('getSonarrQueue(true) sets includeEpisode=true', async () => {
    await getSonarrQueue(true);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'sonarr',
      '/api/v3/queue?includeEpisode=true',
      expect.objectContaining({ schema: expect.anything() }),
    );
  });

  it('putSonarrEpisodesMonitor PUTs api/v3/episode/monitor with {episodeIds, monitored}', async () => {
    await putSonarrEpisodesMonitor([1, 2, 3], false);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'sonarr',
      '/api/v3/episode/monitor',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ episodeIds: [1, 2, 3], monitored: false }),
      }),
    );
  });
});
