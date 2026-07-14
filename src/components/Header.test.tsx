import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { getLanguage } from '../lib/domain/languageSettings';
import { DEFAULT_ADULT_PIN, lockAdult } from '../lib/domain/adultSettings';

function renderHeader() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Header />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, invalidateQueriesSpy };
}

describe('Header language chip (ES⇄EN TMDB metadata toggle)', () => {
  afterEach(() => {
    localStorage.removeItem('poisonflix:language');
  });

  it('renders the current language, defaulting to "ES"', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Cambiar idioma' })).toHaveTextContent('ES');
  });

  it('toggling flips the label from ES to EN', async () => {
    const user = userEvent.setup();
    renderHeader();

    const chip = screen.getByRole('button', { name: 'Cambiar idioma' });
    expect(chip).toHaveTextContent('ES');

    await user.click(chip);

    expect(chip).toHaveTextContent('EN');
    expect(getLanguage()).toBe('en');
  });

  it('toggling invalidates the jellyseerr trending/search/detail query keys', async () => {
    const user = userEvent.setup();
    const { invalidateQueriesSpy } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Cambiar idioma' }));

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['jellyseerr', 'trending'] });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['jellyseerr', 'search'] });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['jellyseerr', 'detail'] });
  });

  it('does NOT invalidate genreRow or library queries (they carry no language param)', async () => {
    const user = userEvent.setup();
    const { invalidateQueriesSpy } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Cambiar idioma' }));

    const invalidatedKeys = invalidateQueriesSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).not.toContainEqual(expect.arrayContaining(['genreRow']));
    expect(invalidatedKeys).not.toContainEqual(expect.arrayContaining(['jellyfin', 'library']));
  });
});

// Surfaces the current pathname so navigation assertions don't need a real
// destination screen mounted.
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="pathname">{location.pathname}</span>;
}

function renderHeaderWithLocation() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Header />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Header +18 button (PIN-gated adult access)', () => {
  afterEach(() => {
    lockAdult();
  });

  it('opens the PIN overlay when the locked +18 button is clicked (no navigation yet)', async () => {
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: /\+18 contenido bloqueado/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('CONTENIDO +18')).toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/');
  });

  it('navigates to /search_adult once the correct PIN is entered', async () => {
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: /\+18 contenido bloqueado/i }));
    for (const digit of DEFAULT_ADULT_PIN.split('')) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    expect(screen.getByTestId('pathname')).toHaveTextContent('/search_adult');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('navigates straight to /search_adult when already unlocked (no PIN prompt)', async () => {
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: /\+18 contenido bloqueado/i }));
    for (const digit of DEFAULT_ADULT_PIN.split('')) {
      await user.click(screen.getByRole('button', { name: digit }));
    }
    expect(screen.getByTestId('pathname')).toHaveTextContent('/search_adult');

    await user.click(screen.getByRole('button', { name: /^contenido \+18$/i }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/search_adult');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
