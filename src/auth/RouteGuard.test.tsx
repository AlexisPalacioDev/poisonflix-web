import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '../routes';
import { AuthProvider } from './AuthContext';
import { clearSession, setSession } from '../lib/session/store';

// Plain MemoryRouter + useRoutes (not createMemoryRouter/RouterProvider):
// the v6 *data* router's redirect navigation goes through an internal
// fetch-like path that isn't jsdom-safe under vitest (App.test.tsx's Slice 0
// note). useRoutes renders the exact same RouteObject[] tree synchronously,
// so <Navigate> redirects work without touching fetch/AbortSignal.
function TestRouteTree() {
  return useRoutes(routes);
}

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient();
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('RouteGuard / PublicOnlyRoute', () => {
  afterEach(() => {
    clearSession();
  });

  it('redirects an unauthenticated user from a protected route to /onboarding', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: /poisonflix/i })).toBeInTheDocument();
  });

  it('redirects an already-authenticated user away from /onboarding (reload persists session, spec scenario)', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });

    renderAt('/onboarding');

    // Home is a placeholder screen (Slice 4); asserting the onboarding form
    // is NOT what rendered is the guard-redirect contract this test covers.
    expect(screen.queryByLabelText(/usuario/i)).not.toBeInTheDocument();
  });

  it('a hydrated session lets a protected route render without re-entering credentials', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });

    renderAt('/');

    expect(screen.queryByLabelText(/usuario/i)).not.toBeInTheDocument();
  });

  it('reactively bounces to /onboarding when the session is cleared mid-session (401 path)', async () => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    renderAt('/');
    // Authenticated: the onboarding form is not shown.
    expect(screen.queryByLabelText(/usuario/i)).not.toBeInTheDocument();

    // The http client clears the session out of band on a 401. The guard must
    // redirect WITHOUT waiting for a remount (the bug this fix closes).
    act(() => {
      clearSession();
    });

    expect(await screen.findByRole('heading', { name: /poisonflix/i })).toBeInTheDocument();
  });
});
