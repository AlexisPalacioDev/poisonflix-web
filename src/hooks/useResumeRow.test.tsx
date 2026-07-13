import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResumeItems } from '../api/jellyfin';
import { AuthProvider } from '../auth/AuthContext';
import { clearSession, setSession } from '../lib/session/store';
import { adultLibraryItemIds } from './useLibraryRow';
import { useResumeRow } from './useResumeRow';

vi.mock('../api/jellyfin', () => ({ getResumeItems: vi.fn() }));
// The adult-exclusion helper is exercised on its own in useLibraryRow's tests;
// here it's stubbed so useResumeRow can be tested in isolation (and so the
// real helper's getUserViews/getItems calls don't need mocking too).
vi.mock('./useLibraryRow', () => ({ adultLibraryItemIds: vi.fn() }));

const mockedGetResumeItems = vi.mocked(getResumeItems);
const mockedAdultLibraryItemIds = vi.mocked(adultLibraryItemIds);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe('useResumeRow (Home "Continuar viendo" data source, projector-feature-map.md §3 row 1)', () => {
  afterEach(() => {
    clearSession();
    mockedGetResumeItems.mockReset();
    mockedAdultLibraryItemIds.mockReset();
  });

  it('fetches the resume feed for the session user with a 20-item limit', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedAdultLibraryItemIds.mockResolvedValue(new Set());
    mockedGetResumeItems.mockResolvedValue({
      Items: [{ Id: 'jf-1', Name: 'Solo Leveling' }] as never,
      TotalRecordCount: 1,
      StartIndex: 0,
    });

    const { result } = renderHook(() => useResumeRow(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedGetResumeItems).toHaveBeenCalledWith('user-1', { limit: 20 });
    expect(result.current.data?.Items).toHaveLength(1);
  });

  it('resolves to an empty item list when the resume feed is empty', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedAdultLibraryItemIds.mockResolvedValue(new Set());
    mockedGetResumeItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 });

    const { result } = renderHook(() => useResumeRow(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.Items).toEqual([]);
  });

  it('excludes adult titles from the resume feed: movies by Id, episodes by SeriesId', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    // Adult set holds a movie Id and an adult SERIES Id (the episodes below
    // carry that SeriesId but have their own distinct Ids).
    mockedAdultLibraryItemIds.mockResolvedValue(new Set(['adult-movie', 'adult-series']));
    mockedGetResumeItems.mockResolvedValue({
      Items: [
        { Id: 'ep-adult', Name: 'Ecchi S01E01', SeriesId: 'adult-series' },
        { Id: 'adult-movie', Name: 'Adult Movie' },
        { Id: 'ep-normal', Name: 'Mr. Robot S01E01', SeriesId: 'safe-series' },
        { Id: 'movie-normal', Name: 'The Matrix' },
      ] as never,
      TotalRecordCount: 4,
      StartIndex: 0,
    });

    const { result } = renderHook(() => useResumeRow(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const ids = (result.current.data?.Items ?? []).map((item) => item.Id);
    expect(ids).toEqual(['ep-normal', 'movie-normal']);
  });

  it('does not fetch when there is no session (enabled gate)', () => {
    const { result } = renderHook(() => useResumeRow(), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedGetResumeItems).not.toHaveBeenCalled();
  });
});
