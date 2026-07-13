import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadingRow } from './DownloadingRow';
import { useDownloads } from '../../hooks/useDownloads';

// `useDownloads` already has its own live-data test coverage (its own hook
// composes `getRequests` + Radarr/Sonarr correlation, projector-feature-map.md
// §9); this row's own responsibility is purely the "still downloading" filter
// + card mapping, so it's mocked directly here to keep the test focused.
vi.mock('../../hooks/useDownloads', () => ({ useDownloads: vi.fn() }));

const mockedUseDownloads = vi.mocked(useDownloads);

function DetailStub() {
  return <h1>Detail Stub</h1>;
}

function renderRow() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<DownloadingRow />} />
        <Route path="/detail/:id" element={<DetailStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

function downloadsResult(items: ReturnType<typeof useDownloads>['items']): ReturnType<typeof useDownloads> {
  return { items, isLoading: false, isError: false, error: null, refetch: vi.fn() };
}

describe('DownloadingRow (projector-feature-map.md §3 row 2, walkthrough §2 "EN CAMINO")', () => {
  afterEach(() => {
    mockedUseDownloads.mockReset();
  });

  it('renders nothing when there are no still-downloading items', () => {
    mockedUseDownloads.mockReturnValue(downloadsResult([]));

    renderRow();

    expect(screen.queryByRole('region', { name: 'En camino' })).not.toBeInTheDocument();
  });

  it('filters out items whose statusLabel is "Disponible" (already finished)', () => {
    mockedUseDownloads.mockReturnValue(
      downloadsResult([
        { id: 1, tmdbId: 603, title: 'The Matrix', posterPath: null, statusLabel: 'Disponible', mediaType: 'movie', percent: 100 },
      ]),
    );

    renderRow();

    expect(screen.queryByRole('region', { name: 'En camino' })).not.toBeInTheDocument();
    expect(screen.queryByText('The Matrix')).not.toBeInTheDocument();
  });

  it('shows an uppercased status badge and the download progress bar for an in-flight item', () => {
    mockedUseDownloads.mockReturnValue(
      downloadsResult([
        { id: 2, tmdbId: 1399, title: 'Game of Thrones', posterPath: null, statusLabel: 'Descargando', mediaType: 'tv', percent: 42 },
      ]),
    );

    renderRow();

    const row = screen.getByRole('region', { name: 'En camino' });
    expect(row).toHaveTextContent('DESCARGANDO');
    const card = screen.getByRole('button', { name: /game of thrones/i });
    const fill = card.querySelector('.pf-poster-card__progress-fill');
    expect(fill).toHaveStyle({ width: '42%' });
  });

  it('clicking a card navigates to /detail/:tmdbId', async () => {
    mockedUseDownloads.mockReturnValue(
      downloadsResult([
        { id: 3, tmdbId: 603, title: 'The Matrix', posterPath: null, statusLabel: 'Pendiente', mediaType: 'movie', percent: undefined },
      ]),
    );

    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: /the matrix/i }));

    expect(await screen.findByRole('heading', { name: /detail stub/i })).toBeInTheDocument();
  });
});
