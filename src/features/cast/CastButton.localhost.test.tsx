import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastButton } from './CastButton';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { fetchCastDevices } from '../../api/cast';

// Its own file because the page origin is per-environment, and this one keeps
// jsdom's default `http://localhost:3000`: the exact situation a developer
// running `npm run dev` is in.
//
// A television cannot open `localhost` - for the TV, that name is the TV. The
// requirement is that the developer LEARNS this, rather than picking a device
// and watching a screen that never changes while the app reports nothing
// wrong.

vi.mock('../../api/cast', () => ({
  fetchCastDevices: vi.fn(),
  playOnDevice: vi.fn(),
  stopDevice: vi.fn(),
}));

const mockedFetchCastDevices = vi.mocked(fetchCastDevices);

describe('CastButton on a localhost origin', () => {
  beforeEach(() => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  });

  afterEach(() => {
    clearSession();
    vi.clearAllMocks();
  });

  it('explains why casting is impossible here, and does not scan the network for it', async () => {
    mockedFetchCastDevices.mockResolvedValue([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <CastButton itemId="item-1" title="Duna" streamUrl="/jellyfin/Videos/item-1/stream.mkv" />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Enviar a la TV' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/localhost/);
    // The message has to say what to do next, not only that something is wrong.
    expect(alert).toHaveTextContent(/IP del servidor/);
    // No point sweeping the LAN for devices we could not hand a usable URL to.
    expect(mockedFetchCastDevices).not.toHaveBeenCalled();
  });
});
