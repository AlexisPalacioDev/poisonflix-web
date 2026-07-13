import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCancelDownload } from './useCancelDownload';
import { cancelDownload } from '../api/bff';

vi.mock('../api/bff', () => ({
  cancelDownload: vi.fn(),
}));

const mockedCancelDownload = vi.mocked(cancelDownload);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useCancelDownload (projector-feature-map.md §9 "Cancel flow")', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls the BFF cancel endpoint with (requestId, tmdbId), in that order', async () => {
    mockedCancelDownload.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: 603, requestId: 42 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedCancelDownload).toHaveBeenCalledWith(42, 603);
  });

  it('a null tmdbId is passed through untouched - the BFF still deletes the Jellyseerr request', async () => {
    mockedCancelDownload.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: null, requestId: 7 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedCancelDownload).toHaveBeenCalledWith(7, null);
  });

  it('propagates a failure from the BFF (e.g. non-owner, non-admin -> 403)', async () => {
    mockedCancelDownload.mockRejectedValue(new Error('403 Forbidden'));

    const { result } = renderHook(() => useCancelDownload(), { wrapper });

    result.current.mutate({ tmdbId: 603, requestId: 42 });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
