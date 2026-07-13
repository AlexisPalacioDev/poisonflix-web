import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContinueWatchingRow } from './ContinueWatchingRow';
import { getResumeItems } from '../../api/jellyfin';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';

vi.mock('../../api/jellyfin', () => ({ getResumeItems: vi.fn() }));

const mockedGetResumeItems = vi.mocked(getResumeItems);

function PlayerStub() {
  return <h1>Player Stub</h1>;
}

function DetailStub() {
  return <h1>Detail Stub</h1>;
}

function renderRow() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<ContinueWatchingRow />} />
            <Route path="/player/:id" element={<PlayerStub />} />
            <Route path="/detail/:id" element={<DetailStub />} />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ContinueWatchingRow (projector-feature-map.md §3 row 1, walkthrough §2)', () => {
  afterEach(() => {
    clearSession();
    mockedGetResumeItems.mockReset();
  });

  it('renders nothing when the resume feed is empty (no empty state)', async () => {
    mockedGetResumeItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 });

    renderRow();

    await waitFor(() => expect(mockedGetResumeItems).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Continuar viendo' })).not.toBeInTheDocument();
  });

  it('renders a card with a progress bar sized to PlayedPercentage (ticks ratio)', async () => {
    mockedGetResumeItems.mockResolvedValue({
      Items: [
        {
          Id: 'jf-solo-leveling',
          Name: 'Solo Leveling',
          RunTimeTicks: 1000,
          UserData: { PlaybackPositionTicks: 250, PlayCount: 1, Played: false, IsFavorite: false },
        },
      ] as never,
      TotalRecordCount: 1,
      StartIndex: 0,
    });

    renderRow();

    expect(await screen.findByRole('region', { name: 'Continuar viendo' })).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /solo leveling/i });
    const fill = card.querySelector('.pf-poster-card__progress-fill');
    expect(fill).toHaveStyle({ width: '25%' });
  });

  it('clicking a card plays directly (/player/:id), not the detail screen', async () => {
    mockedGetResumeItems.mockResolvedValue({
      Items: [{ Id: 'jf-solo-leveling', Name: 'Solo Leveling' }] as never,
      TotalRecordCount: 1,
      StartIndex: 0,
    });

    const user = userEvent.setup();
    renderRow();

    const card = await screen.findByRole('button', { name: /solo leveling/i });
    await user.click(card);

    expect(await screen.findByRole('heading', { name: /player stub/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /detail stub/i })).not.toBeInTheDocument();
  });
});
