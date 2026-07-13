import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResumeItems } from '../api/jellyfin';
import { AuthProvider } from '../auth/AuthContext';
import { clearSession, setSession } from '../lib/session/store';
import { useResumeRow } from './useResumeRow';

vi.mock('../api/jellyfin', () => ({ getResumeItems: vi.fn() }));

const mockedGetResumeItems = vi.mocked(getResumeItems);

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
  });

  it('fetches the resume feed for the session user with a 20-item limit', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
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
    mockedGetResumeItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 });

    const { result } = renderHook(() => useResumeRow(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.Items).toEqual([]);
  });

  it('does not fetch when there is no session (enabled gate)', () => {
    const { result } = renderHook(() => useResumeRow(), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedGetResumeItems).not.toHaveBeenCalled();
  });
});
