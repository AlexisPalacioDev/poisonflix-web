import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useParams, useRoutes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailScreen } from './DetailScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItems } from '../../api/jellyfin';
import { getMovieDetails, requestMedia } from '../../api/jellyseerr';

vi.mock('../../api/jellyfin', () => ({ getItems: vi.fn() }));
vi.mock('../../api/jellyseerr', () => ({ getMovieDetails: vi.fn(), requestMedia: vi.fn() }));

const mockedGetItems = vi.mocked(getItems);
const mockedGetMovieDetails = vi.mocked(getMovieDetails);
const mockedRequestMedia = vi.mocked(requestMedia);

const EMPTY_LIBRARY = { Items: [], TotalRecordCount: 0, StartIndex: 0 };

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 603,
    title: 'The Matrix',
    overview: 'A hacker discovers reality is a simulation.',
    releaseDate: '1999-03-30',
    posterPath: '/matrix.jpg',
    backdropPath: '/matrix-backdrop.jpg',
    voteAverage: 8.2,
    runtime: 136,
    mediaInfo: null,
    ...overrides,
  };
}

/** Test-only stand-in for PlayerScreen so navigation from "Reproducir" is observable. */
function TestPlayerScreen() {
  const { id } = useParams<{ id: string }>();
  return <p>player-screen:{id}</p>;
}

function TestRouteTree() {
  return useRoutes([
    { path: '/detail/:id', element: <DetailScreen /> },
    { path: '/player/:id', element: <TestPlayerScreen /> },
  ]);
}

function renderDetail(tmdbId = '603') {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={[`/detail/${tmdbId}`]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('DetailScreen (detail-request spec)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedGetMovieDetails.mockReset();
    mockedRequestMedia.mockReset();
  });

  it('InLibrary: shows "Reproducir" and hides "Pedir"; clicking it navigates to /player/:jellyfinItemId', async () => {
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'jf-603', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture() as never);

    renderDetail('603');

    const playButton = await screen.findByRole('button', { name: /reproducir/i });
    expect(screen.queryByRole('button', { name: /^pedir$/i })).not.toBeInTheDocument();

    fireEvent.click(playButton);

    expect(await screen.findByText('player-screen:jf-603')).toBeInTheDocument();
  });

  it('Requestable: shows an enabled "Pedir" action and no "Reproducir"', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);

    renderDetail('603');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    expect(requestButton).toBeEnabled();
    expect(screen.queryByRole('button', { name: /reproducir/i })).not.toBeInTheDocument();
  });

  it('Requesting: action is disabled and shows the current Jellyseerr status, no duplicate-request affordance', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(
      detailFixture({ mediaInfo: { id: 1, status: 3, mediaType: 'movie' } }) as never,
    );

    renderDetail('603');

    const pendingButton = await screen.findByRole('button', { name: /descargando/i });
    expect(pendingButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^pedir$/i })).not.toBeInTheDocument();
  });

  it('Successful request: status updates from response.media.status, not an assumed local value', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);
    mockedRequestMedia.mockResolvedValue({
      id: 1,
      type: 'movie',
      status: 1,
      media: { id: 1, tmdbId: 603, mediaType: 'movie', status: 2 },
    } as never);

    renderDetail('603');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    fireEvent.click(requestButton);

    expect(await screen.findByRole('button', { name: /pendiente/i })).toBeDisabled();
    expect(mockedRequestMedia).toHaveBeenCalledWith({ mediaType: 'movie', mediaId: 603 });
    expect(screen.queryByRole('button', { name: /^pedir$/i })).not.toBeInTheDocument();
  });

  it('Failed request: status remains Requestable, no optimistic "Requesting" state, error is shown', async () => {
    mockedGetItems.mockResolvedValue(EMPTY_LIBRARY as never);
    mockedGetMovieDetails.mockResolvedValue(detailFixture({ mediaInfo: null }) as never);
    mockedRequestMedia.mockRejectedValue(new Error('network down'));

    renderDetail('603');

    const requestButton = await screen.findByRole('button', { name: /^pedir$/i });
    fireEvent.click(requestButton);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    const stillRequestButton = screen.getByRole('button', { name: /^pedir$/i });
    expect(stillRequestButton).toBeEnabled();
  });
});
