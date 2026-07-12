import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItems } from '../../api/jellyfin';
import { discoverTrending } from '../../api/jellyseerr';

vi.mock('../../api/jellyfin', () => ({ getItems: vi.fn() }));
vi.mock('../../api/jellyseerr', () => ({ discoverTrending: vi.fn() }));

const mockedGetItems = vi.mocked(getItems);
const mockedDiscoverTrending = vi.mocked(discoverTrending);

const LIBRARY_FIXTURE = {
  Items: [{ Id: 'jf-1', Name: 'The Matrix', ProviderIds: { Tmdb: '603' }, ImageTags: null }],
  TotalRecordCount: 1,
  StartIndex: 0,
};

const TRENDING_FIXTURE = {
  page: 1,
  totalPages: 1,
  totalResults: 1,
  results: [
    {
      id: 100,
      mediaType: 'movie',
      title: 'Trending Movie',
      name: null,
      releaseDate: '2024-01-01',
      firstAirDate: null,
      overview: null,
      posterPath: '/poster.jpg',
      backdropPath: null,
      voteAverage: 8,
      adult: false,
      genreIds: [],
      mediaInfo: null,
    },
  ],
};

function renderHome() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <HomeScreen />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('HomeScreen - row isolation (home spec)', () => {
  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedDiscoverTrending.mockReset();
  });

  it('renders exactly the Library and Trending row titles (fixed MVP row set)', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    mockedDiscoverTrending.mockResolvedValue(TRENDING_FIXTURE as never);

    renderHome();

    expect(await screen.findByText('The Matrix')).toBeInTheDocument();
    expect(await screen.findByText('Trending Movie')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tu biblioteca' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tendencias' })).toBeInTheDocument();
  });

  it('Trending fails: Library still renders its items normally (row isolation)', async () => {
    mockedGetItems.mockResolvedValue(LIBRARY_FIXTURE as never);
    mockedDiscoverTrending.mockRejectedValue(new Error('jellyseerr down'));

    renderHome();

    // Library row unaffected by the Trending failure.
    expect(await screen.findByText('The Matrix')).toBeInTheDocument();

    // Trending row shows its own row-scoped error, not a screen-wide blank.
    const trendingRow = screen.getByRole('region', { name: 'Tendencias' });
    expect(trendingRow).toHaveTextContent(/no se pudo cargar/i);
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });

  it('Library fails: Trending still renders its items normally (row isolation)', async () => {
    mockedGetItems.mockRejectedValue(new Error('jellyfin down'));
    mockedDiscoverTrending.mockResolvedValue(TRENDING_FIXTURE as never);

    renderHome();

    // Trending row unaffected by the Library failure.
    expect(await screen.findByText('Trending Movie')).toBeInTheDocument();

    // Library row shows its own row-scoped error, not a screen-wide blank.
    const libraryRow = screen.getByRole('region', { name: 'Tu biblioteca' });
    expect(libraryRow).toHaveTextContent(/no se pudo cargar/i);
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });
});
