import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchMusic, warmMusicTrack } from '../api/music';
import { useMusicSearch } from './useMusicSearch';

// Warming the top of the results list is a side effect of the search
// landing, not the search itself — `searchMusic` stays real (mocked to
// return fixtures) while `warmMusicTrack` is the thing under test here.
vi.mock('../api/music', async () => {
  const actual = await vi.importActual<typeof import('../api/music')>('../api/music');
  return { ...actual, searchMusic: vi.fn(), warmMusicTrack: vi.fn() };
});

const mockedSearchMusic = vi.mocked(searchMusic);
const mockedWarmMusicTrack = vi.mocked(warmMusicTrack);

function song(videoId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'song' as const,
    videoId,
    title: `Song ${videoId}`,
    artist: 'Someone',
    artists: ['Someone'],
    album: null,
    durationSeconds: 180,
    thumbnailUrl: null,
    source: 'ytmusic',
    genre: null,
    downloaded: false,
    jellyfinItemId: null,
    rating: 0,
    ...overrides,
  };
}

function album(browseId: string) {
  return {
    type: 'album' as const,
    browseId,
    title: 'An Album',
    artist: 'Someone',
    thumbnailUrl: null,
    trackCount: 10,
    year: 2020,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function search(query: string) {
  const rendered = renderHook(() => useMusicSearch(query), { wrapper });
  await waitFor(() => expect(rendered.result.current.results.length).toBeGreaterThan(0));
  return rendered;
}

describe('useMusicSearch — warming the top of the results list', () => {
  afterEach(() => {
    mockedSearchMusic.mockReset();
    mockedWarmMusicTrack.mockReset();
  });

  it('warms each not-yet-downloaded song hit at url depth', async () => {
    mockedSearchMusic.mockResolvedValue([song('vid-1'), song('vid-2')] as never);

    await search('a song');

    await waitFor(() => expect(mockedWarmMusicTrack).toHaveBeenCalledTimes(2));
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-1', 'ytmusic', 'url');
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-2', 'ytmusic', 'url');
  });

  it('caps the warm at the top 5 results, not the whole page', async () => {
    const hits = Array.from({ length: 8 }, (_, i) => song(`vid-${i}`));
    mockedSearchMusic.mockResolvedValue(hits as never);

    await search('a song');

    await waitFor(() => expect(mockedWarmMusicTrack).toHaveBeenCalledTimes(5));
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-0', 'ytmusic', 'url');
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-4', 'ytmusic', 'url');
    expect(mockedWarmMusicTrack).not.toHaveBeenCalledWith('vid-5', 'ytmusic', 'url');
  });

  it('skips a hit already in the library — it plays from Jellyfin, never the worker', async () => {
    mockedSearchMusic.mockResolvedValue([
      song('vid-downloaded', { downloaded: true, jellyfinItemId: 'aud-1' }),
      song('vid-preview'),
    ] as never);

    await search('a song');

    await waitFor(() => expect(mockedWarmMusicTrack).toHaveBeenCalledTimes(1));
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-preview', 'ytmusic', 'url');
  });

  it('skips album/playlist collection hits — the endpoint warms one videoId, not a batch', async () => {
    mockedSearchMusic.mockResolvedValue([album('browse-1'), song('vid-1')] as never);

    await search('a song');

    await waitFor(() => expect(mockedWarmMusicTrack).toHaveBeenCalledTimes(1));
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-1', 'ytmusic', 'url');
  });

  it('normalizes an unrecognized source to auto, same fallback previewStreamUrl uses', async () => {
    mockedSearchMusic.mockResolvedValue([song('vid-1', { source: 'something-else' })] as never);

    await search('a song');

    await waitFor(() => expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-1', 'auto', 'url'));
  });
});
