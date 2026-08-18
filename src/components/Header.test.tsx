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

  // Shared dismissal via OverlayShell (design D: `sdd/mobile-music-overhaul`).
  // Header used to close the menu via a bare `document.addEventListener`
  // ('mousedown') with no backdrop node at all - the pattern suspected of
  // failing on iOS Safari, where a tap on "non-clickable" background can skip
  // `mousedown` entirely.
  it('clicking outside the open menu (the real backdrop node) closes it', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    const panel = screen.getByRole('menu', { name: 'Menú de navegación' });

    // A real, clickable backdrop node - not a bare document listener.
    const backdrop = screen.getByRole('button', { name: 'Cerrar menú (fondo)' });
    await user.click(backdrop);

    expect(panel).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('returns focus to the hamburger toggle after closing via the backdrop', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    const toggle = screen.getByRole('button', { name: 'Abrir menú' });
    await user.click(toggle);

    await user.click(screen.getByRole('button', { name: 'Cerrar menú (fondo)' }));

    expect(toggle).toHaveFocus();
  });

  it('locks body scroll while the mobile menu is open', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    expect(document.body.style.position).toBe('fixed');

    await user.keyboard('{Escape}');
    expect(document.body.style.position).toBe('');
  });

  // Real-Chrome audit finding: `.pf-header` is `position: fixed`, so it
  // always creates its own stacking context. The panel was rendered as a
  // plain (non-portalled) sibling INSIDE that context while the backdrop
  // portalled straight to `document.body` (outside it). Both ended up at the
  // same z-index at the ROOT stacking context, and the backdrop - painted
  // later in document order there - covered the entire panel: every tap on a
  // menu item actually hit the backdrop and just closed the menu instead of
  // navigating. The regression this test exists to catch is exactly that:
  // clicking an item must NAVIGATE, not merely close the menu.
  //
  // jsdom does no layout/paint, so it cannot reproduce the actual mis-stack
  // or prove a real tap lands on the right element - `fireEvent`/`userEvent`
  // dispatch straight to the target node regardless of what visually
  // overlaps it. What this test DOES verify (and what regressed): the link's
  // own click handler runs end-to-end and produces real navigation. The
  // structural side of the fix (panel portalled after the backdrop in the
  // same container) is covered generically by `OverlayShell.test.tsx`.
  it('clicking a nav item inside the mobile menu navigates (not just closes)', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    await user.click(screen.getByRole('link', { name: 'Buscar' }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/search');
    expect(screen.queryByRole('link', { name: 'Buscar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toHaveAttribute('aria-expanded', 'false');
  });

  // Structural proxy for the same fix, since jsdom can't assert real paint
  // order: backdrop and panel must share the SAME portal container, with the
  // panel after the backdrop in document order - the exact invariant that
  // makes the panel win the stacking comparison in a real browser regardless
  // of `.pf-header`'s own `position: fixed` context.
  it('portals the backdrop and the menu panel into the same container, panel after backdrop', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderWithLocation();

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));

    const backdrop = screen.getByRole('button', { name: 'Cerrar menú (fondo)' });
    const panel = screen.getByRole('menu', { name: 'Menú de navegación' });

    expect(backdrop.parentElement).toBe(panel.parentElement?.parentElement);
    // eslint-disable-next-line no-bitwise
    expect(backdrop.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// The section selector. This used to be a flip-flop ("in Música? then the
// button goes back to films"), which is only expressible while there are two
// sections. With three there is no "the other one": what the header owes the
// user is a way into every section they are NOT in, and no way into the one
// they already are.
describe('Header section selector (cine / Música / Juegos)', () => {
  afterEach(() => {
    setCompactViewport(false);
  });

  it('from cinema, offers the two other sections and not cinema itself', () => {
    renderHeaderAt('/');

    expect(screen.getByRole('link', { name: 'Música' })).toHaveAttribute('href', '/musica');
    expect(screen.getByRole('link', { name: 'Juegos' })).toHaveAttribute('href', '/juegos');
    expect(screen.queryByRole('link', { name: 'Películas y series' })).not.toBeInTheDocument();
  });

  it('from Música, offers cinema and Juegos and not Música itself', () => {
    renderHeaderAt('/musica');

    expect(screen.getByRole('link', { name: 'Películas y series' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Juegos' })).toHaveAttribute('href', '/juegos');
    expect(screen.queryByRole('link', { name: 'Música' })).not.toBeInTheDocument();
  });

  it('from Juegos, offers cinema and Música and not Juegos itself', () => {
    renderHeaderAt('/juegos');

    expect(screen.getByRole('link', { name: 'Películas y series' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Música' })).toHaveAttribute('href', '/musica');
    expect(screen.queryByRole('link', { name: 'Juegos' })).not.toBeInTheDocument();
  });

  // /jam belongs to the Música world (it is listening together), so it must be
  // treated as Música here - not as a fourth section, and not as cinema.
  it('treats /jam as Música', () => {
    renderHeaderAt('/jam');

    expect(screen.queryByRole('link', { name: 'Música' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Películas y series' })).toBeInTheDocument();
  });

  it('picking a section actually navigates there', async () => {
    const user = userEvent.setup();
    renderHeaderAt('/musica');

    await user.click(screen.getByRole('link', { name: 'Películas y series' }));

    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/$/);
  });

  it('the selector also appears inside the mobile hamburger menu', async () => {
    setCompactViewport(true);
    const user = userEvent.setup();
    renderHeaderAt('/musica/album/1');

    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));

    expect(screen.getByRole('link', { name: 'Películas y series' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Juegos' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Música' })).not.toBeInTheDocument();
  });
});

describe('Header brand (per-section identity)', () => {
  it('wears PoisonFlix in cinema', () => {
    renderHeaderAt('/');
    expect(screen.getByRole('link', { name: 'PoisonFlix - Inicio' })).toHaveAttribute('href', '/');
  });

  it('wears PoisonFy in Música, and its home is Música', () => {
    renderHeaderAt('/musica/album/1');
    expect(screen.getByRole('link', { name: 'PoisonFy - Inicio' })).toHaveAttribute(
      'href',
      '/musica',
    );
  });

  it('wears PoisonPlay in Juegos, and its home is Juegos', () => {
    renderHeaderAt('/juegos/play/zelda');
    expect(screen.getByRole('link', { name: 'PoisonPlay - Inicio' })).toHaveAttribute(
      'href',
      '/juegos',
    );
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
    // Found by URL rather than by position: the header also mounts the Jam
    // invitation bell, which polls /bff/jam, so the logout is no longer the
    // first request the header makes. What matters is that it is made, with
    // the cookie, as a POST — not where it lands in the list.
    expect(fetchSpy).toHaveBeenCalled();
    const logoutCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/jellyseerr/api/v1/auth/logout'),
    );
    expect(logoutCall, 'the server-side logout was never requested').toBeDefined();
    expect(logoutCall?.[1]?.method).toBe('POST');
    expect(logoutCall?.[1]?.credentials).toBe('include');

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
