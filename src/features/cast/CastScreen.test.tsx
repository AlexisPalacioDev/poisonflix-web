import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getCurrentUser, getItem, getPlaybackInfo } from '../../api/jellyfin';
import { ApiError } from '../../lib/http/errors';

// The bug this route exists for, stated once: a television opening a cast URL
// has NO session - ours lives in the phone's localStorage - so `/player/:id`
// bounced it to the login screen while the app announced "Reproduciendo en LG
// del living". Every test below is rendered with the session cleared, on the
// REAL route tree (`routes`), because "renders without a session" is a claim
// about the route registration as much as about the component: mounting
// `<CastScreen/>` directly would pass even if the route were still behind
// `RouteGuard`.
//
// Plain MemoryRouter + useRoutes rather than createMemoryRouter, for the same
// jsdom reason as `RouteGuard.test.tsx`.

vi.mock('../../api/jellyfin', async () => {
  const actual = await vi.importActual<typeof import('../../api/jellyfin')>('../../api/jellyfin');
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getPlaybackInfo: vi.fn(),
    getItem: vi.fn(),
  };
});

const mockedGetCurrentUser = vi.mocked(getCurrentUser);
const mockedGetPlaybackInfo = vi.mocked(getPlaybackInfo);
const mockedGetItem = vi.mocked(getItem);

const URL_TOKEN = 'tv-token';

function stubHappyPath(itemId = 'jf-item-1') {
  mockedGetCurrentUser.mockResolvedValue({ Id: 'user-1', Name: 'alexis' });
  mockedGetPlaybackInfo.mockResolvedValue({
    MediaSources: [
      {
        Id: 'ms-1',
        Container: 'mp4',
        TranscodingUrl: null,
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: false,
        MediaStreams: [],
      },
    ],
    PlaySessionId: 'sess-1',
  } as never);
  mockedGetItem.mockResolvedValue({
    Id: itemId,
    Name: 'Night of the Living Dead',
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
  } as never);
}

function renderAt(entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function TestRouteTree() {
    return useRoutes(routes);
  }
  render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('/cast/:id (the public playback surface a television opens)', () => {
  afterEach(() => {
    cleanup();
    clearSession();
    vi.clearAllMocks();
  });

  it('plays the video with no session at all, instead of bouncing to the login screen', async () => {
    stubHappyPath();

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}&autoplay=1`);

    const video = await screen.findByTestId('pf-video');
    expect(video).toHaveAttribute(
      'src',
      '/jellyfin/Videos/jf-item-1/stream.mp4?static=true&mediaSourceId=ms-1&api_key=tv-token',
    );
    // The onboarding form is what a guarded route would have rendered here.
    expect(screen.queryByLabelText(/usuario/i)).not.toBeInTheDocument();
  });

  // The token is a key to ONE door. Anything that could turn it into a master
  // key - a way back into the app, a library, an account - must not be here.
  it('offers no way out of this one video: no back button, no navigation', async () => {
    stubHappyPath();

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);
    await screen.findByTestId('pf-video');

    expect(screen.queryByRole('button', { name: 'Volver' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // The persistent music bar lives in `AppLayout`; this route is outside it.
    expect(screen.queryByRole('button', { name: /enviar a la tv/i })).not.toBeInTheDocument();
    // The track menus are the one part of the surface that would otherwise
    // still render: the subtitle button has no `length > 0` guard of its own,
    // and it would open a dialog whose every apply handler here is a no-op.
    expect(screen.queryByRole('button', { name: 'Subtítulos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Audio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Episodios' })).not.toBeInTheDocument();
    // What a cast surface IS: transport controls.
    expect(screen.getByRole('slider', { name: /progreso/i })).toBeInTheDocument();
  });

  // The credential has to come from the URL, not from whatever session happens
  // to exist in THIS browser - otherwise the route would work only on the
  // machine that is already logged in, which is the bug wearing a disguise.
  it('authenticates with the URL token, not with a session that happens to be present', async () => {
    setSession({ jellyfinToken: 'phone-session-token', jellyfinUserId: 'user-9', jellyseerrCookiePresent: true });
    stubHappyPath();

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);
    await screen.findByTestId('pf-video');

    expect(mockedGetCurrentUser).toHaveBeenCalledWith({ authToken: URL_TOKEN });
    expect(mockedGetPlaybackInfo).toHaveBeenCalledWith(
      'jf-item-1',
      expect.objectContaining({ userId: 'user-1' }),
      { authToken: URL_TOKEN },
    );
    expect(mockedGetItem).toHaveBeenCalledWith('user-1', 'jf-item-1', expect.any(String), {
      authToken: URL_TOKEN,
    });
  });

  // A blank screen on a television is indistinguishable from a dead app.
  it.each([
    ['no token param at all', '/cast/jf-item-1'],
    ['an empty token param', '/cast/jf-item-1?token='],
    ['a whitespace-only token', '/cast/jf-item-1?token=%20%20'],
  ])('says what is wrong when the link arrives with %s', async (_label, entry) => {
    stubHappyPath();

    renderAt(entry);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/credencial/i);
    // And it must not have gone to the network with nothing to authenticate
    // with - a silent 401 is what produced the blank screen in the first place.
    expect(mockedGetCurrentUser).not.toHaveBeenCalled();
    expect(mockedGetPlaybackInfo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pf-video')).not.toBeInTheDocument();
  });

  // "The link went stale, ask for it again" and "the network is broken" have
  // different fixes for whoever is standing in front of the TV.
  it('distinguishes a rejected token from a server it cannot reach', async () => {
    mockedGetCurrentUser.mockRejectedValue(new ApiError(401, 'Unauthorized'));

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ya no sirve/i);
    expect(alert).not.toHaveTextContent(/misma red/i);
  });

  // The playback query cannot run without a user id, so it would never fail
  // and never resolve: the television would sit on "Cargando…" all evening
  // with nothing to read.
  it('does not spin forever when the server answers without a user id', async () => {
    stubHappyPath();
    // After `stubHappyPath`, which sets a real one - the item endpoints stay
    // available on purpose, so the only thing missing is the id.
    mockedGetCurrentUser.mockResolvedValue({ Id: '', Name: 'nobody' });

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);

    expect(await screen.findByRole('alert')).toHaveTextContent(/misma red/i);
    expect(screen.queryByText('Cargando…')).not.toBeInTheDocument();
  });

  // The same dead end reached through an answer with NO BODY, which is a
  // separate path into it: `apiFetch` returns `undefined` for a 204 before it
  // ever validates the schema (`lib/http/client.ts`), and a captive portal or
  // a probe-intercepting proxy answers 204 to everything - exactly the network
  // a television lands on by accident. What catches it today is react-query
  // refusing a query function that resolves `undefined`; this pins the OUTCOME
  // (a sentence, never a spinner) rather than that mechanism, so replacing the
  // library or the 204 shortcut cannot reopen it in silence.
  it('does not spin forever when the server answers with no body at all', async () => {
    stubHappyPath();
    mockedGetCurrentUser.mockResolvedValue(undefined as never);

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);

    expect(await screen.findByRole('alert')).toHaveTextContent(/misma red/i);
    expect(screen.queryByText('Cargando…')).not.toBeInTheDocument();
  });

  it('blames the network, not the link, when the request simply fails', async () => {
    mockedGetCurrentUser.mockRejectedValue(new ApiError(500, 'Server error'));

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/misma red/i);
  });

  // The token worked and the server answered: this account cannot play this
  // item, or it is gone. Sending someone to restart a router over a
  // permissions problem is the false-diagnosis shape this route exists to stop
  // reproducing.
  it.each([403, 404])('does not blame the network for a %i on the item', async (status) => {
    mockedGetCurrentUser.mockResolvedValue({ Id: 'user-1', Name: 'alexis' });
    mockedGetPlaybackInfo.mockRejectedValue(new ApiError(status, 'Nope'));
    mockedGetItem.mockRejectedValue(new ApiError(status, 'Nope'));

    renderAt(`/cast/jf-item-1?token=${URL_TOKEN}`);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no está disponible para la cuenta/i);
    expect(alert).not.toHaveTextContent(/misma red/i);
    expect(alert).not.toHaveTextContent(/ya no sirve/i);
  });
});
