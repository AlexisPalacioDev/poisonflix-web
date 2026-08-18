import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';
import { AuthProvider } from '../../auth/AuthContext';
import { rememberSection } from '../../lib/domain/lastSection';

// Reopening where you left off. The layout writes the section on every
// navigation and reads it back on the next launch — and that read used to be a
// single `=== 'musica'` test, which silently made every section added after
// music non-resumable.

vi.mock('./useAutoplayRadio', () => ({ useAutoplayRadio: () => {} }));
vi.mock('./useMusicScrobble', () => ({ useMusicScrobble: () => {} }));
vi.mock('./NowPlayingBar', () => ({ NowPlayingBar: () => null }));

function LocationProbe() {
  return <span data-testid="pathname">{useLocation().pathname}</span>;
}

function renderAtRoot() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<span>cine</span>} />
              <Route path="/musica" element={<span>musica</span>} />
              <Route path="/juegos" element={<span>juegos</span>} />
            </Route>
          </Routes>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppLayout — reopening in the last section', () => {
  afterEach(() => {
    localStorage.removeItem('poisonflix:lastSection');
  });

  it('sends someone whose last section was Música to /musica', () => {
    rememberSection('musica');
    renderAtRoot();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/musica');
  });

  it('sends someone whose last section was Juegos to /juegos', () => {
    rememberSection('juegos');
    renderAtRoot();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/juegos');
  });

  it('leaves someone whose last section was cinema on /', () => {
    rememberSection('cine');
    renderAtRoot();
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/$/);
  });

  it('with nothing remembered, opens cinema', () => {
    renderAtRoot();
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/$/);
  });

  it('remembers the section it is standing in', () => {
    rememberSection('cine');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/juegos']}>
          <AuthProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/juegos" element={<span>juegos</span>} />
              </Route>
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(localStorage.getItem('poisonflix:lastSection')).toBe('juegos');
  });
});
