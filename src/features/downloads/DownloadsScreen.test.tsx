import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadsScreen } from './DownloadsScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getRequests } from '../../api/jellyseerr';
import { useDownloadProgress } from '../../hooks/useDownloadProgress';
import { useCancelDownload } from '../../hooks/useCancelDownload';

vi.mock('../../api/jellyseerr', () => ({ getRequests: vi.fn(), deleteRequest: vi.fn() }));
vi.mock('../../hooks/useDownloadProgress', () => ({ useDownloadProgress: vi.fn() }));
vi.mock('../../hooks/useCancelDownload', () => ({ useCancelDownload: vi.fn() }));

const mockedGetRequests = vi.mocked(getRequests);
const mockedUseDownloadProgress = vi.mocked(useDownloadProgress);
const mockedUseCancelDownload = vi.mocked(useCancelDownload);

const EMPTY_REQUESTS_FIXTURE = { pageInfo: { pages: 0, pageSize: 20, results: 0, page: 1 }, results: [] };

const REQUESTS_FIXTURE = {
  pageInfo: { pages: 1, pageSize: 20, results: 2, page: 1 },
  results: [
    {
      id: 1,
      type: 'movie',
      status: 2,
      media: { id: 11, tmdbId: 603, tvdbId: null, mediaType: 'movie', status: 3, status4k: null, serviceUrl: null, jellyfinMediaId: null },
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 2,
      type: 'tv',
      status: 2,
      media: { id: 12, tmdbId: 1399, tvdbId: null, mediaType: 'tv', status: 5, status4k: null, serviceUrl: null, jellyfinMediaId: null },
      createdAt: null,
      updatedAt: null,
    },
  ],
};

function mockCancelDownload() {
  const mutate = vi.fn();
  mockedUseCancelDownload.mockReturnValue({
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    isIdle: true,
    data: undefined,
    error: null,
    reset: vi.fn(),
    status: 'idle',
    variables: undefined,
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    submittedAt: 0,
  } as never);
  return mutate;
}

function renderDownloads() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/downloads']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DownloadsScreen />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('DownloadsScreen (projector-feature-map.md §9, walkthrough §14)', () => {
  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetRequests.mockReset();
    mockedUseDownloadProgress.mockReset();
    mockedUseCancelDownload.mockReset();
    vi.useRealTimers();
  });

  it('renders each request as a card with its uppercased status pill and live %', async () => {
    mockedGetRequests.mockResolvedValue(REQUESTS_FIXTURE as never);
    mockedUseDownloadProgress.mockReturnValue({
      progressByTmdbId: new Map([[603, 42]]),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never);
    mockCancelDownload();

    renderDownloads();

    expect(await screen.findByText('DESCARGANDO')).toBeInTheDocument();
    expect(await screen.findByText('DISPONIBLE')).toBeInTheDocument();

    const fill = document.querySelector('.pf-poster-card__progress-fill');
    expect(fill).toHaveStyle({ width: '42%' });
  });

  it('shows the mascot + empty-state copy when there are no active requests', async () => {
    mockedGetRequests.mockResolvedValue(EMPTY_REQUESTS_FIXTURE as never);
    mockedUseDownloadProgress.mockReturnValue({
      progressByTmdbId: new Map(),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never);
    mockCancelDownload();

    renderDownloads();

    const emptyState = await screen.findByText('No hay nada descargándose ahora mismo.');
    expect(emptyState).toBeInTheDocument();
    expect(
      within(emptyState.parentElement as HTMLElement).getByRole('img', { name: 'PoisonFlix' }),
    ).toBeInTheDocument();
  });

  it('long-press opens the cancel confirm overlay, and confirming triggers the cancel mutation', async () => {
    mockedGetRequests.mockResolvedValue(REQUESTS_FIXTURE as never);
    mockedUseDownloadProgress.mockReturnValue({
      progressByTmdbId: new Map([[603, 42]]),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never);
    const mutate = mockCancelDownload();

    renderDownloads();

    // Target the card itself, not the sibling "Cancelar" action that now also
    // carries 603 in its accessible name - hence the title-then-closest-button
    // lookup instead of a name regex.
    const card = (await screen.findByText('603')).closest('button') as HTMLElement;

    vi.useFakeTimers();
    fireEvent.pointerDown(card);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(card);
    fireEvent.click(card);
    vi.useRealTimers();

    expect(await screen.findByText('Cancelar descarga')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sí, cancelar' }));

    expect(mutate).toHaveBeenCalledWith({ tmdbId: 603, requestId: 1 }, expect.anything());
    expect(screen.queryByText('Cancelar descarga')).not.toBeInTheDocument();
  });

  it('exposes a per-card Cancelar action reachable without a long-press', async () => {
    mockedGetRequests.mockResolvedValue(REQUESTS_FIXTURE as never);
    mockedUseDownloadProgress.mockReturnValue({
      progressByTmdbId: new Map([[603, 42]]),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never);
    const mutate = mockCancelDownload();

    renderDownloads();

    // The long-press is ported from a D-pad remote and is undiscoverable with
    // a mouse, so the action also exists as a real control. It is a sibling of
    // the card (the card is itself a <button>), revealed on hover/focus by CSS
    // but always present in the DOM - which is what makes it keyboard-reachable
    // rather than mouse-only.
    const cancel = await screen.findByRole('button', { name: 'Cancelar la descarga de 603' });

    fireEvent.click(cancel);

    // Same confirm overlay as the long-press path - one cancel flow, two ways in.
    expect(await screen.findByText('Cancelar descarga')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sí, cancelar' }));

    expect(mutate).toHaveBeenCalledWith({ tmdbId: 603, requestId: 1 }, expect.anything());
  });
});
