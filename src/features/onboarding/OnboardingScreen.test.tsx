import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, getSession } from '../../lib/session/store';
import { authenticateByName } from '../../api/jellyfin';
import { authJellyfin } from '../../api/jellyseerr';
import { ApiError, NetworkError } from '../../lib/http/errors';

vi.mock('../../api/jellyfin', () => ({ authenticateByName: vi.fn() }));
vi.mock('../../api/jellyseerr', () => ({ authJellyfin: vi.fn() }));

const mockedAuthenticateByName = vi.mocked(authenticateByName);
const mockedAuthJellyfin = vi.mocked(authJellyfin);

// Plain MemoryRouter + useRoutes, not createMemoryRouter/RouterProvider - see
// RouteGuard.test.tsx's note: the v6 data router's redirect navigation isn't
// jsdom-safe under vitest, and this suite navigates on successful login.
function TestRouteTree() {
  return useRoutes(routes);
}

function renderOnboarding() {
  const queryClient = new QueryClient();
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/usuario/i), 'perroenvenenado');
  await user.type(screen.getByLabelText(/contraseña/i), 'pass1234');
  await user.click(screen.getByRole('button', { name: /conectar/i }));
}

describe('OnboardingScreen', () => {
  afterEach(() => {
    clearSession();
    mockedAuthenticateByName.mockReset();
    mockedAuthJellyfin.mockReset();
  });

  it('happy path: both backends succeed, persists the session, and navigates to Home', async () => {
    mockedAuthenticateByName.mockResolvedValue({
      User: { Id: 'user-1', Name: 'perroenvenenado' },
      AccessToken: 'token-abc',
      ServerId: 'server-1',
    });
    mockedAuthJellyfin.mockResolvedValue({ id: 1, email: null, username: 'perroenvenenado', permissions: 2 } as never);

    const user = userEvent.setup();
    renderOnboarding();
    await fillAndSubmit(user);

    // Home is a real screen as of Slice 4 (Library + Trending rows, no
    // "Home" placeholder heading anymore) - assert the onboarding form is
    // gone instead of a heading text that no longer exists, same pattern as
    // RouteGuard.test.tsx's guard-redirect assertions.
    await waitFor(() => expect(screen.queryByLabelText(/usuario/i)).not.toBeInTheDocument());
    expect(getSession()).toEqual({
      jellyfinToken: 'token-abc',
      jellyfinUserId: 'user-1',
      jellyfinServerId: 'server-1',
      jellyseerrCookiePresent: true,
      isAdmin: true,
    });
  });

  it('Jellyfin auth fails: shows an error, never calls Jellyseerr, persists nothing', async () => {
    mockedAuthenticateByName.mockRejectedValue(new ApiError(401, 'bad credentials'));

    const user = userEvent.setup();
    renderOnboarding();
    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/usuario o contraseña/i);
    expect(mockedAuthJellyfin).not.toHaveBeenCalled();
    expect(getSession()).toBeNull();
  });

  it('Jellyfin succeeds, Jellyseerr fails: discards the token, persists nothing, stays on onboarding', async () => {
    mockedAuthenticateByName.mockResolvedValue({
      User: { Id: 'user-1', Name: 'perroenvenenado' },
      AccessToken: 'token-abc',
      ServerId: 'server-1',
    });
    mockedAuthJellyfin.mockRejectedValue(new ApiError(401, 'jellyseerr rejected'));

    const user = userEvent.setup();
    renderOnboarding();
    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/jellyseerr/i);
    expect(getSession()).toBeNull();
    expect(screen.getByLabelText(/usuario/i)).toBeInTheDocument();
  });

  it('surfaces a distinct proxy/connectivity message on a NetworkError, not a credentials message', async () => {
    mockedAuthenticateByName.mockRejectedValue(new NetworkError());

    const user = userEvent.setup();
    renderOnboarding();
    await fillAndSubmit(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/proxy|conectar/i);
    expect(alert).not.toHaveTextContent(/usuario o contraseña/i);
  });

  it('rejects submission with empty fields without calling either backend', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(screen.getByRole('button', { name: /conectar/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/completá/i);
    expect(mockedAuthenticateByName).not.toHaveBeenCalled();
    expect(mockedAuthJellyfin).not.toHaveBeenCalled();
  });

  it('shows the fixed same-origin proxy prefixes as read-only info under an advanced disclosure', () => {
    renderOnboarding();
    expect(screen.getByText('Configuración avanzada')).toBeInTheDocument();
    expect(screen.getByText('/jellyfin')).toBeInTheDocument();
    expect(screen.getByText('/jellyseerr')).toBeInTheDocument();
  });
});
