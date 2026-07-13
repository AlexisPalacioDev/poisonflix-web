import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAnilistCover } from '../../api/anilist';
import { searchAdult } from '../../api/prowlarr';
import { AuthProvider } from '../../auth/AuthContext';
import { DEFAULT_ADULT_PIN, lockAdult } from '../../lib/domain/adultSettings';
import { clearSession, setSession } from '../../lib/session/store';
import { AdultSection } from './AdultSection';

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

const mockedSearchAdult = vi.mocked(searchAdult);
const mockedGetAnilistCover = vi.mocked(getAnilistCover);

function renderSection() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AdultSection />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AdultSection', () => {
  afterEach(() => {
    clearSession();
    lockAdult();
    mockedSearchAdult.mockReset();
    mockedGetAnilistCover.mockReset();
  });

  it('shows the locked BLOQUEADO tile by default (no request made)', () => {
    renderSection();

    expect(screen.getByText('BLOQUEADO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+18 contenido bloqueado/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockedSearchAdult).not.toHaveBeenCalled();
  });

  it('opens the PIN overlay when the locked tile is clicked', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /\+18 contenido bloqueado/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('CONTENIDO +18')).toBeInTheDocument();
  });

  it('shows the search pill and the +18 row once unlocked', async () => {
    mockedSearchAdult.mockResolvedValue([]);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /\+18 contenido bloqueado/i }));
    for (const digit of DEFAULT_ADULT_PIN.split('')) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    expect(screen.getByRole('link', { name: /BUSCAR EN \+18/i })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '+18' })).toBeInTheDocument();
    expect(screen.queryByText('BLOQUEADO')).not.toBeInTheDocument();
  });
});
