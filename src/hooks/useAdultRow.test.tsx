import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAnilistCover } from '../api/anilist';
import { searchAdult } from '../api/prowlarr';
import type { ProwlarrRelease } from '../api/schemas/prowlarr';
import { AuthProvider } from '../auth/AuthContext';
import { lockAdult, tryUnlock } from '../lib/domain/adultSettings';
import { clearSession, setSession } from '../lib/session/store';
import { collapseAdultReleases, useAdultRow } from './useAdultRow';

vi.mock('../api/prowlarr', () => ({
  searchAdult: vi.fn(),
  grabRelease: vi.fn(),
  ADULT_INDEXER_IDS: [23, 16],
  ADULT_BROWSE_QUERY: 'hentai',
}));
vi.mock('../api/anilist', () => ({
  getAnilistCover: vi.fn(),
  getAnilistInfo: vi.fn(),
  cleanReleaseTitle: (raw: string) =>
    raw
      .replace(/^\[[^\]]*\]\s*/, '')
      .split(/[._\s-]*[Ss]\d{1,2}[Ee]\d/)[0]
      .replace(/[._]/g, ' ')
      .trim(),
}));

const mockedSearchAdult = vi.mocked(searchAdult);
const mockedGetAnilistCover = vi.mocked(getAnilistCover);

function release(overrides: Partial<ProwlarrRelease> & { title: string } & { indexerId?: number }): ProwlarrRelease {
  return {
    guid: 'guid-1',
    seeders: 0,
    leechers: 0,
    tmdbId: 0,
    tvdbId: 0,
    ...overrides,
  } as unknown as ProwlarrRelease;
}

describe('collapseAdultReleases (pure collapse-by-show logic)', () => {
  it('collapses per-episode releases of the same show into one entry, best-seeded wins', () => {
    const releases = [
      release({ title: '[Group] Show A S01E01 1080p', seeders: 5, guid: 'g1', indexerId: 23 }),
      release({ title: '[Group] Show A S01E02 1080p', seeders: 40, guid: 'g2', indexerId: 23 }),
      release({ title: '[Group] Show A S01E03 1080p', seeders: 10, guid: 'g3', indexerId: 23 }),
    ];

    const collapsed = collapseAdultReleases(releases);

    expect(collapsed).toEqual([{ title: 'Show A', guid: 'g2', indexerId: 23 }]);
  });

  it('keeps distinct shows independent', () => {
    const releases = [
      release({ title: 'Show A S01E01', seeders: 1, guid: 'g1' }),
      release({ title: 'Show B S01E01', seeders: 2, guid: 'g2' }),
    ];

    const collapsed = collapseAdultReleases(releases);

    expect(collapsed.map((s) => s.title).sort()).toEqual(['Show A', 'Show B']);
  });

  it('drops a release that cleans to an empty title', () => {
    const releases = [release({ title: '   ', guid: 'g1' })];

    expect(collapseAdultReleases(releases)).toEqual([]);
  });

  it('respects the limit', () => {
    const releases = Array.from({ length: 5 }, (_, i) => release({ title: `Show ${i}`, guid: `g${i}` }));

    expect(collapseAdultReleases(releases, 2)).toHaveLength(2);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe('useAdultRow (wired hook: Prowlarr collapse + AniList enrich)', () => {
  afterEach(() => {
    clearSession();
    lockAdult();
    mockedSearchAdult.mockReset();
    mockedGetAnilistCover.mockReset();
  });

  it('collapses Prowlarr releases by show and enriches each with an AniList cover', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    tryUnlock('6969');
    mockedSearchAdult.mockResolvedValue([
      release({ title: 'Do You Like Big Girls S01E01', seeders: 3, guid: 'g1' }),
      release({ title: 'Do You Like Big Girls S01E02', seeders: 9, guid: 'g2' }),
    ]);
    mockedGetAnilistCover.mockResolvedValue('https://anilist.example/cover.jpg');

    const { result } = renderHook(() => useAdultRow(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      {
        title: 'Do You Like Big Girls',
        prowlarrGuid: 'g2',
        prowlarrIndexerId: null,
        posterUrl: 'https://anilist.example/cover.jpg',
      },
    ]);
    expect(mockedGetAnilistCover).toHaveBeenCalledWith('Do You Like Big Girls');
  });

  it('degrades to an empty row (no crash) when Prowlarr 401s without an API key', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    tryUnlock('6969');
    mockedSearchAdult.mockRejectedValue(new Error('Unauthorized - prowlarr proxy has no API key configured'));

    const { result } = renderHook(() => useAdultRow(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
    expect(result.current.isError).toBe(false);
    expect(mockedGetAnilistCover).not.toHaveBeenCalled();
  });

  it('does not fetch while the +18 section is locked', () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });

    const { result } = renderHook(() => useAdultRow(), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedSearchAdult).not.toHaveBeenCalled();
  });

  it('does not fetch without a session, even when unlocked', () => {
    tryUnlock('6969');

    const { result } = renderHook(() => useAdultRow(), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedSearchAdult).not.toHaveBeenCalled();
  });
});
