import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { AuthProvider } from '../auth/AuthContext';
import { getLanguage } from '../lib/domain/languageSettings';
import { DEFAULT_ADULT_PIN, lockAdult } from '../lib/domain/adultSettings';
import { clearSession, getSession, setSession } from '../lib/session/store';

// Header now reads useAuth() (Admin link gating) - every render needs an
// AuthProvider ancestor, same as RouteGuard.test.tsx.
function renderHeader() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <Header />
        </AuthProvider>
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
        <AuthProvider>
          <Header />
          <LocationProbe />
        </AuthProvider>
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

// Forces the desktop (false) or mobile/compact (true) header layout by making
// `matchMedia('(max-width: 899px)')` (the shared breakpoint) report `matches`.
// Mirrors NowPlayingBar.test.tsx's helper.
function setCompactViewport(isCompact: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: isCompact && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderHeaderAt(route: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Header />
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Header mobile hamburger menu (< 899px)', () => {
  afterEach(() => {
    setCompactViewport(false);
    clearSession();
    vi.restoreAllMocks();
  });

  it('on desktop the nav buttons render inline with no hamburger toggle', () => {
    setCompactViewport(false);
    renderHeaderWithLocation();

    expect(screen.getByRole('link', { name: 'Buscar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abrir menú' })).not.toBeInTheDocument();
  });

  it('on mobile the nav items collapse behind a hamburger toggle and stay hidden until it is opened', () => {
    setCompactViewport(true);
    renderHeaderWithLocation();

    const toggle = screen.getByRole('button', { name: 'Abrir menú' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The brand stays visible on the left.
    expect(screen.getByRole('link', { name: 'PoisonFlix - Inicio' })).toBeInTheDocument();
    // The individual controls are not in the DOM until the menu opens.
    expect(screen.queryByRole('link', { name: 'Buscar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cambiar idioma' })).not.toBeInTheDocument();
  });

  it('opening the menu reveals every nav item', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));

    const toggle = screen.getByRole('button', { name: 'Cerrar menú' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Buscar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Música' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Descargas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cambiar idioma' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('logout works from the mobile menu (clears session + redirects) and the menu closes', async () => {
    setCompactViewport(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));

    await waitFor(() => expect(getSession()).toBeNull());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/onboarding');
    // Selecting an item closes the menu (toggle reads "Abrir menú" again).
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toBeInTheDocument();
  });

  it('Escape closes the open menu', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    expect(screen.getByRole('link', { name: 'Buscar' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('link', { name: 'Buscar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Header context-aware Música / "back to Netflix mode" button', () => {
  afterEach(() => {
    setCompactViewport(false);
  });

  it('outside the music section shows the "Música" link to /musica', () => {
    renderHeaderAt('/');

    const musica = screen.getByRole('link', { name: 'Música' });
    expect(musica).toHaveAttribute('href', '/musica');
    expect(screen.queryByRole('button', { name: 'Volver a películas y series' })).not.toBeInTheDocument();
  });

  it('inside the music section swaps to a "Volver a películas y series" button that returns home', async () => {
    const user = userEvent.setup();
    renderHeaderAt('/musica');

    expect(screen.queryByRole('link', { name: 'Música' })).not.toBeInTheDocument();
    const back = screen.getByRole('button', { name: 'Volver a películas y series' });

    await user.click(back);

    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/$/);
  });

  it('the context toggle also appears inside the mobile hamburger menu', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderAt('/musica/album/1');

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));

    expect(screen.getByRole('button', { name: 'Volver a películas y series' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Música' })).not.toBeInTheDocument();
  });
});

describe('Header logout ("Cerrar sesión")', () => {
  afterEach(() => {
    clearSession();
    vi.restoreAllMocks();
  });

  function renderAuthenticatedHeader() {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    return renderHeaderWithLocation();
  }

  it('invalidates the server-side Jellyseerr session, clears the local session and redirects to /onboarding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderAuthenticatedHeader();

    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));

    // Server-side logout hit through apiFetch: POST to the Jellyseerr logout
    // endpoint with the same-origin cookie included so `connect.sid` is cleared.
    expect(fetchSpy).toHaveBeenCalled();
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain('/jellyseerr/api/v1/auth/logout');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');

    // Local teardown + redirect to the login screen.
    await waitFor(() => expect(getSession()).toBeNull());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/onboarding');
  });

  it('still clears the local session and redirects when the server logout call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderAuthenticatedHeader();

    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));

    // Best-effort: a failed server logout must never trap the user - local
    // session is cleared and they land back on onboarding regardless.
    await waitFor(() => expect(getSession()).toBeNull());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/onboarding');
  });
});
