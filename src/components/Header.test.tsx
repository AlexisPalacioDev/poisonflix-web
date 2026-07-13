import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { getLanguage } from '../lib/domain/languageSettings';

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
