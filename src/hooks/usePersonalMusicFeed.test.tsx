import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlayedAudio, getRandomLibraryAudio } from '../api/jellyfin';
import { getPreviewPlays, getRadio, getRecommendations } from '../api/music';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import type { MusicPlay, MusicResultItem, MusicSongResult } from '../api/schemas/music';
import { AuthProvider } from '../auth/AuthContext';
import { clearSession, setSession } from '../lib/session/store';
import { usePersonalMusicFeed } from './usePersonalMusicFeed';

// This hook is the site of the production bug: with an empty Jellyfin music
// library, every "Porque escuchaste X" row rendered the same five tracks and
// ignored what the owner actually listens to (YouTube Music previews). These
// tests wire the whole hook — mocking only the network boundary — because the
// bug lived in how the tiers compose, not in any one pure function.

vi.mock('../api/jellyfin', () => ({
  getPlayedAudio: vi.fn(),
  getRandomLibraryAudio: vi.fn(),
}));
vi.mock('../api/music', () => ({
  getPreviewPlays: vi.fn(),
  getRadio: vi.fn(),
  getRecommendations: vi.fn(),
}));

const mockedGetPlayedAudio = vi.mocked(getPlayedAudio);
const mockedGetRandomLibraryAudio = vi.mocked(getRandomLibraryAudio);
const mockedGetPreviewPlays = vi.mocked(getPreviewPlays);
const mockedGetRadio = vi.mocked(getRadio);
const mockedGetRecommendations = vi.mocked(getRecommendations);

function emptyJellyfinResult() {
  return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
}

function libraryItem(overrides: Partial<JellyfinItem> & { Id: string; Name: string }): JellyfinItem {
  return overrides as JellyfinItem;
}

function play(overrides: Partial<MusicPlay> & { videoId: string }): MusicPlay {
  return { count: 1, title: '', artist: '', seconds: 0, ...overrides };
}

function song(videoId: string, artist: string | null = null): MusicSongResult {
  return {
    type: 'song',
    videoId,
    title: `Song ${videoId}`,
    artist,
    artists: artist ? [artist] : [],
    album: null,
    durationSeconds: null,
    thumbnailUrl: null,
    source: 'ytmusic',
    genre: null,
    downloaded: false,
    jellyfinItemId: null,
    rating: 0,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe('usePersonalMusicFeed', () => {
  afterEach(() => {
    clearSession();
    mockedGetPlayedAudio.mockReset();
    mockedGetRandomLibraryAudio.mockReset();
    mockedGetPreviewPlays.mockReset();
    mockedGetRadio.mockReset();
    mockedGetRecommendations.mockReset();
  });

  it('seeds from the worker\'s real plays when Jellyfin has no history and no library', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'v1', artist: 'Metrikas Frias', title: 'Track 1', count: 9 }),
      play({ videoId: 'v2', artist: 'Alcolirykoz', title: 'Track 2', count: 4 }),
    ]);
    mockedGetRadio.mockImplementation((seed) =>
      Promise.resolve('videoId' in seed ? [song(`radio-for-${seed.videoId}`)] : []),
    );

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGeneric).toBe(false);
    expect(mockedGetRandomLibraryAudio).not.toHaveBeenCalled();
    expect(mockedGetRadio).toHaveBeenCalledWith({ videoId: 'v1' }, expect.any(Number));
    expect(mockedGetRadio).toHaveBeenCalledWith({ videoId: 'v2' }, expect.any(Number));
    const titles = result.current.rows.map((row) => row.title);
    expect(titles).toContain('Porque escuchaste Metrikas Frias');
    expect(titles).toContain('Porque escuchaste Alcolirykoz');
  });

  it('falls back to Jellyfin play history when the worker has no plays yet', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPreviewPlays.mockResolvedValue([]);
    mockedGetPlayedAudio.mockResolvedValue({
      Items: [libraryItem({ Id: 'jf-1', Name: 'Track A', Artists: ['Jellyfin Artist'] })],
      TotalRecordCount: 1,
      StartIndex: 0,
    });
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRadio.mockResolvedValue([song('radio-1', 'Jellyfin Artist')]);

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGeneric).toBe(false);
    expect(mockedGetRandomLibraryAudio).not.toHaveBeenCalled();
    expect(mockedGetRadio).toHaveBeenCalledWith({ itemId: 'jf-1' }, expect.any(Number));
    expect(result.current.rows.map((row) => row.title)).toContain('Porque escuchaste Jellyfin Artist');
  });

  it('discards a play with no usable artist or title instead of showing a broken row', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'unlabelled-video-id', artist: '', title: '', count: 20 }),
      play({ videoId: 'v-ok', artist: 'Real Artist', title: 'Real Title', count: 1 }),
    ]);
    mockedGetRadio.mockResolvedValue([song('radio-1', 'Real Artist')]);

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const titles = result.current.rows.map((row) => row.title);
    expect(titles.some((title) => title.includes('unlabelled-video-id'))).toBe(false);
    expect(titles.some((title) => title === 'Porque escuchaste ')).toBe(false);
    expect(titles).toContain('Porque escuchaste Real Artist');
  });

  it('spreads seeds across distinct artists instead of stacking rows on one', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'v1', artist: 'Same Artist', title: 'T1', count: 9 }),
      play({ videoId: 'v2', artist: 'Same Artist', title: 'T2', count: 8 }),
      play({ videoId: 'v3', artist: 'Same Artist', title: 'T3', count: 7 }),
      play({ videoId: 'v4', artist: 'Different Artist', title: 'T4', count: 1 }),
    ]);
    mockedGetRadio.mockImplementation((seed) =>
      Promise.resolve('videoId' in seed ? [song(`radio-for-${seed.videoId}`)] : []),
    );

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const seedRowTitles = result.current.rows
      .map((row) => row.title)
      .filter((title) => title.startsWith('Porque escuchaste'));
    expect(seedRowTitles).toEqual([
      'Porque escuchaste Same Artist',
      'Porque escuchaste Different Artist',
    ]);
  });

  it('gives each row its own radio — the reported bug was every row sharing one radio', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'v1', artist: 'Artist One', title: 'T1', count: 9 }),
      play({ videoId: 'v2', artist: 'Artist Two', title: 'T2', count: 4 }),
    ]);
    mockedGetRadio.mockImplementation((seed) => {
      if ('videoId' in seed && seed.videoId === 'v1') return Promise.resolve([song('only-in-one')]);
      if ('videoId' in seed && seed.videoId === 'v2') return Promise.resolve([song('only-in-two')]);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const videoIdsOf = (items: MusicResultItem[] | undefined) =>
      (items ?? []).filter((item): item is MusicSongResult => item.type === 'song').map((item) => item.videoId);
    const rowOne = result.current.rows.find((row) => row.title === 'Porque escuchaste Artist One');
    const rowTwo = result.current.rows.find((row) => row.title === 'Porque escuchaste Artist Two');
    expect(videoIdsOf(rowOne?.items)).toEqual(['only-in-one']);
    expect(videoIdsOf(rowTwo?.items)).toEqual(['only-in-two']);
  });

  it('degrades cleanly to the generic feed with no plays and no library — never a broken row', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([]);
    mockedGetRecommendations.mockResolvedValue([song('generic-1')]);

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGeneric).toBe(true);
    expect(result.current.rows).toEqual([
      { key: 'generic', title: 'Populares en YouTube Music', items: [song('generic-1')] },
    ]);
    expect(mockedGetRadio).not.toHaveBeenCalled();
  });

  it('asks the worker for a PURE (seed-only) radio for each "Porque escuchaste" row, and two different seeds never share content', async () => {
    // mobile-music-overhaul fix-seeded-rows: the worker's three user-global
    // sources (your artists/likes/history) used to be mixed into every
    // seed's radio, so two different seeds converged on the same tracks. The
    // fix is `pure: true` on the seed-row radios; this test fails red against
    // the pre-fix hook because it never asked for `pure` at all, so both
    // rows' mocked responses (which only vary on the `pure` flag) collapse to
    // the same content.
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'v1', artist: 'Artist One', title: 'T1', count: 9 }),
      play({ videoId: 'v2', artist: 'Artist Two', title: 'T2', count: 4 }),
    ]);
    // The worker's real `pure` mode: seed-dependent content only, genuinely
    // different per seed. Anything requested WITHOUT `pure` gets the same
    // "shared-track" back for every seed — modelling the three user-global
    // sources that used to leak into every row.
    mockedGetRadio.mockImplementation((seed, _limit, opts) => {
      if (!('videoId' in seed)) return Promise.resolve([]);
      if (opts?.pure) return Promise.resolve([song(`pure-only-${seed.videoId}`)]);
      return Promise.resolve([song('shared-global-track')]);
    });

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockedGetRadio).toHaveBeenCalledWith({ videoId: 'v1' }, expect.any(Number), { pure: true });
    expect(mockedGetRadio).toHaveBeenCalledWith({ videoId: 'v2' }, expect.any(Number), { pure: true });

    const videoIdsOf = (items: MusicResultItem[] | undefined) =>
      (items ?? []).filter((item): item is MusicSongResult => item.type === 'song').map((item) => item.videoId);
    const rowOne = result.current.rows.find((row) => row.title === 'Porque escuchaste Artist One');
    const rowTwo = result.current.rows.find((row) => row.title === 'Porque escuchaste Artist Two');
    expect(videoIdsOf(rowOne?.items)).toEqual(['pure-only-v1']);
    expect(videoIdsOf(rowTwo?.items)).toEqual(['pure-only-v2']);
    // Neither seed row is the shared, non-pure track — that would be the bug.
    expect(videoIdsOf(rowOne?.items)).not.toContain('shared-global-track');
    expect(videoIdsOf(rowTwo?.items)).not.toContain('shared-global-track');
  });

  it('falls back to the generic feed when seeds exist but every radio comes back empty — never zero rows with no message', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'v1', artist: 'Artist One', title: 'T1', count: 9 }),
    ]);
    // Every radio call — pure or not — settles successfully but with nothing:
    // a cold worker container, or ytmusicapi returning an empty mix.
    mockedGetRadio.mockResolvedValue([]);
    mockedGetRecommendations.mockResolvedValue([song('generic-1')]);

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGeneric).toBe(true);
    expect(result.current.rows.length).toBeGreaterThan(0);
    expect(result.current.rows).toEqual([
      { key: 'generic', title: 'Populares en YouTube Music', items: [song('generic-1')] },
    ]);
  });

  it('falls back to the generic feed when seeds exist but every radio call fails — never zero rows with no message', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlayedAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetRandomLibraryAudio.mockResolvedValue(emptyJellyfinResult());
    mockedGetPreviewPlays.mockResolvedValue([
      play({ videoId: 'v1', artist: 'Artist One', title: 'T1', count: 9 }),
    ]);
    // A 502 from an unreachable music worker: every radio request rejects.
    mockedGetRadio.mockRejectedValue(new Error('music_worker_unreachable'));
    mockedGetRecommendations.mockResolvedValue([song('generic-1')]);

    const { result } = renderHook(() => usePersonalMusicFeed(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGeneric).toBe(true);
    expect(result.current.rows.length).toBeGreaterThan(0);
    expect(result.current.rows).toEqual([
      { key: 'generic', title: 'Populares en YouTube Music', items: [song('generic-1')] },
    ]);
  });
});
