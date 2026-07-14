import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdultSearchScreen } from './AdultSearchScreen';
import { getAnilistCover } from '../../api/anilist';
import { getItems, getUserViews } from '../../api/jellyfin';
import { searchAdult } from '../../api/prowlarr';
import { AuthProvider } from '../../auth/AuthContext';
import { DEFAULT_ADULT_PIN, lockAdult, tryUnlock } from '../../lib/domain/adultSettings';
import { clearSession, setSession } from '../../lib/session/store';

vi.mock('../../api/prowlarr', () => ({
  searchAdult: vi.fn(),
  grabRelease: vi.fn(),
  ADULT_INDEXER_IDS: [23, 16],
  ADULT_BROWSE_QUERY: 'hentai',
}));
vi.mock('../../api/anilist', () => ({
  getAnilistCover: vi.fn(),
  getAnilistInfo: vi.fn(),
  cleanReleaseTitle: (raw: string) => raw.trim(),
}));
vi.mock('../../api/jellyfin', () => ({
  getUserViews: vi.fn(),
  getItems: vi.fn(),
  deleteItem: vi.fn(),
}));

const mockedSearchAdult = vi.mocked(searchAdult);
const mockedGetAnilistCover = vi.mocked(getAnilistCover);
const mockedGetUserViews = vi.mocked(getUserViews);
const mockedGetItems = vi.mocked(getItems);

function renderScreen() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <MemoryRouter initialEntries={['/search_adult']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AdultSearchScreen />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AdultSearchScreen (dedicated +18 screen)', () => {
  afterEach(() => {
    clearSession();
    lockAdult();
    mockedSearchAdult.mockReset();
    mockedGetAnilistCover.mockReset();
    mockedGetUserViews.mockReset();
    mockedGetItems.mockReset();
  });

  it('locked (direct visit / reload): shows the PIN gate and no adult content', () => {
    renderScreen();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('CONTENIDO +18')).toBeInTheDocument();
    // No rows, no search box, and NO calls to any adult data source.
    expect(screen.queryByRole('region', { name: 'Ya descargado' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: /buscar en \+18/i })).not.toBeInTheDocument();
    expect(mockedSearchAdult).not.toHaveBeenCalled();
    expect(mockedGetUserViews).not.toHaveBeenCalled();
  });

  it('unlocked: lists downloaded +18 titles and the available-to-request row', async () => {
    mockedSearchAdult.mockResolvedValue([]);
    mockedGetUserViews.mockResolvedValue({
      Items: [{ Id: 'adlib', Name: 'Adultos' }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    mockedGetItems.mockResolvedValue({
      Items: [{ Id: 'a1', Name: 'Downloaded Hentai', Type: 'Movie', ProviderIds: {} }],
      TotalRecordCount: 1,
      StartIndex: 0,
    } as never);
    // Pre-unlock so the screen renders its content branch directly.
    tryUnlock(DEFAULT_ADULT_PIN);

    renderScreen();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /buscar en \+18/i })).toBeInTheDocument();

    // Downloaded row shows the real Jellyfin library title.
    const downloadedRow = await screen.findByRole('region', { name: 'Ya descargado' });
    expect(await within(downloadedRow).findByText('Downloaded Hentai')).toBeInTheDocument();

    // Available-to-request (Prowlarr) row is present too.
    expect(screen.getByRole('region', { name: 'Disponibles +18' })).toBeInTheDocument();
  });
});
