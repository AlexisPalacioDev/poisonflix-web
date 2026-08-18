/**
 * @vitest-environment-options { "url": "http://192.168.1.50:8600/player/item-1" }
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastButton } from './CastButton';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { fetchCastDevices, playOnDevice, stopDevice } from '../../api/cast';
import { ApiError } from '../../lib/http/errors';
import type { CastDevice } from '../../api/schemas/cast';

// The page origin is pinned to a LAN address by the docblock above: at
// jsdom's default `localhost` this component would (correctly) refuse to cast
// at all, which is its own test file.

// The three network calls are mocked; `castFailureReason` is NOT. It is pure
// parsing of an error body, and stubbing it would make the tests below assert
// that the component calls something, rather than that the sentence the bridge
// sent reaches the screen.
vi.mock('../../api/cast', async () => {
  const actual = await vi.importActual<typeof import('../../api/cast')>('../../api/cast');
  return {
    ...actual,
    fetchCastDevices: vi.fn(),
    playOnDevice: vi.fn(),
    stopDevice: vi.fn(),
  };
});

const mockedFetchCastDevices = vi.mocked(fetchCastDevices);
const mockedPlayOnDevice = vi.mocked(playOnDevice);
const mockedStopDevice = vi.mocked(stopDevice);

const STREAM = '/jellyfin/Videos/item-1/stream.mkv?static=true&api_key=tok';

const LIVING_ROOM: CastDevice = {
  id: 'ssap:192.168.1.20',
  name: 'LG del living',
  address: '192.168.1.20',
  protocol: 'ssap',
  capability: 'app',
  model: 'OLED55',
};

const UNUSABLE: CastDevice = {
  id: 'dial:192.168.1.31',
  name: 'Samsung del cuarto',
  address: '192.168.1.31',
  protocol: 'dial',
  capability: 'none',
  reason: 'Esta TV no tiene la app PoisonFlix instalada.',
};

function renderButton() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CastButton itemId="item-1" title="Duna" streamUrl={STREAM} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Renders the button and opens its sheet - the state every test below but
 *  the first one starts from. */
async function openMenu() {
  const user = userEvent.setup();
  renderButton();
  await user.click(screen.getByRole('button', { name: 'Enviar a la TV' }));
  return user;
}

describe('CastButton', () => {
  beforeEach(() => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  });

  afterEach(() => {
    clearSession();
    vi.clearAllMocks();
  });

  // A scan is a multicast sweep that takes seconds. Nobody asked for one just
  // because they pressed play.
  it('does not scan the network until the menu is opened', () => {
    mockedFetchCastDevices.mockResolvedValue([]);
    renderButton();

    expect(mockedFetchCastDevices).not.toHaveBeenCalled();
  });

  // The rule the whole feature is judged by: the television the user is
  // staring at is listed, dimmed, with the reason it cannot be used. Hiding it
  // would leave them asking why their Samsung "does not appear".
  it('lists an unusable device, disabled, with its reason readable', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM, UNUSABLE]);
    const user = await openMenu();

    const blocked = await screen.findByRole('button', { name: /Samsung del cuarto/ });
    // `aria-disabled`, not the `disabled` attribute - the row has to stay
    // reachable by a screen reader, which is the whole point of showing it.
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAccessibleDescription('Esta TV no tiene la app PoisonFlix instalada.');
    expect(screen.getByText('Esta TV no tiene la app PoisonFlix instalada.')).toBeInTheDocument();

    await user.click(blocked);
    expect(mockedPlayOnDevice).not.toHaveBeenCalled();
  });

  it('falls back to a sentence when the bridge marks a device unusable without saying why', async () => {
    mockedFetchCastDevices.mockResolvedValue([{ ...UNUSABLE, reason: undefined }]);
    await openMenu();

    expect(
      await screen.findByText('Este dispositivo no acepta reproducción desde PoisonFlix.'),
    ).toBeInTheDocument();
  });

  // A `capability: 'app'` television authenticates with nothing but what is in
  // the URL it was handed. Without a token there is no URL worth handing it -
  // and the media URL's own `api_key` came from that same token - so the honest
  // answer is a reason, not a send that 401s where nobody can see it.
  it('refuses to offer casting when the session has no token, and says why', async () => {
    setSession({ jellyfinToken: '', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);

    await openMenu();

    expect(await screen.findByRole('alert')).toHaveTextContent(/credencial/i);
    // No point sweeping the LAN for devices we could only hand a broken URL.
    expect(mockedFetchCastDevices).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /LG del living/ })).not.toBeInTheDocument();
  });

  it('sends both absolute URLs and the title to the chosen device', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({ ok: true });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));

    expect(mockedPlayOnDevice).toHaveBeenCalledWith({
      deviceId: 'ssap:192.168.1.20',
      // The PUBLIC route, carrying the token: `/player/:id` is behind
      // `RouteGuard`, and a television has no session of ours to satisfy it.
      appUrl: 'http://192.168.1.50:8600/cast/item-1?token=tok&autoplay=1',
      mediaUrl: `http://192.168.1.50:8600${STREAM}`,
      title: 'Duna',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Reproduciendo en LG del living.');
  });

  // Pairing is a step the user completes on the television, not an error they
  // have to debug - so it must not be announced as one.
  it('reads needsPairing as an instruction, not a failure', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({ ok: false, needsPairing: true });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));

    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/Aceptá el mensaje que apareció en LG del living/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // …and the device stays usable, because retrying after accepting works.
    const device = screen.getByRole('button', { name: /LG del living/ });
    expect(device).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(device);
    expect(mockedPlayOnDevice).toHaveBeenCalledTimes(2);
  });

  it('offers to stop what it started', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({ ok: true });
    mockedStopDevice.mockResolvedValue({ ok: true });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));
    await user.click(await screen.findByRole('button', { name: /Detener en LG del living/ }));

    expect(mockedStopDevice).toHaveBeenCalledWith('ssap:192.168.1.20');
  });

  // The adapters spend real effort turning a protocol failure into a sentence
  // someone can act on. The schema used to strip it and the sheet said
  // "rechazó la reproducción. Probá de nuevo." to a person whose television
  // simply does not have the app installed - advice that leads nowhere.
  it('says what the television actually answered, not a generic rejection', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({
      ok: false,
      reason:
        'La TV ya no tiene la app PoisonFlix instalada. Instalala desde su tienda y volvé a escanear.',
    });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'La TV ya no tiene la app PoisonFlix instalada. Instalala desde su tienda y volvé a escanear.',
    );
    expect(alert).not.toHaveTextContent('rechazó la reproducción');
  });

  it('falls back to its own sentence when the bridge sent none', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({ ok: false });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'LG del living rechazó la reproducción. Probá de nuevo.',
    );
  });

  // A device that left the network comes back as a THROWN 404 carrying its own
  // sentence. The catch-all copy blames the WiFi, which is the wrong thing to
  // go check for a television that is on and simply moved.
  it('reads the reason out of a failure that arrived as an error status', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockRejectedValue(
      new ApiError(404, 'Request failed: 404 Not Found', {
        ok: false,
        error: 'unknown_device',
        reason: 'Ese dispositivo ya no aparece en la red. Volvé a escanear.',
      }),
    );
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ese dispositivo ya no aparece en la red. Volvé a escanear.');
    expect(alert).not.toHaveTextContent('en la misma red');
  });

  // Stopping answers `ok: false` over HTTP 200 exactly like starting does.
  // Ignoring it announced "Reproducción detenida" over a television that was
  // still playing - and took away the button that offers to try again.
  it('does not claim a stop succeeded when the device refused it', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({ ok: true });
    mockedStopDevice.mockResolvedValue({
      ok: false,
      reason: 'El Chromecast no confirmó que haya detenido el video.',
    });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));
    await user.click(await screen.findByRole('button', { name: /Detener en LG del living/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El Chromecast no confirmó que haya detenido el video.',
    );
    expect(screen.queryByText('Reproducción detenida en LG del living.')).not.toBeInTheDocument();
    // The offer to try again survives, because it is still playing.
    expect(screen.getByRole('button', { name: /Detener en LG del living/ })).toBeInTheDocument();
  });

  // The LG adapter answers `needsPairing` on stop too - it cannot close the app
  // until the television accepts the connection. Reading that as a plain error
  // would colour a step the user can complete as a dead end.
  it('treats pairing on a stop as a step, not a failure', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockResolvedValue({ ok: true });
    mockedStopDevice.mockResolvedValue({
      ok: false,
      needsPairing: true,
      reason: 'La TV no aceptó la conexión, así que no se pudo cerrar nada.',
    });
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));
    await user.click(await screen.findByRole('button', { name: /Detener en LG del living/ }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      /Aceptá el mensaje que apareció en LG del living/,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The claim above is worth nothing unless retrying actually works: a
    // `pendingDeviceId` left set by the early return would swallow the second
    // tap in silence and every assertion so far would still pass.
    await user.click(screen.getByRole('button', { name: /Detener en LG del living/ }));
    expect(mockedStopDevice).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejection from the television instead of claiming success', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    mockedPlayOnDevice.mockRejectedValue(new Error('bridge down'));
    const user = await openMenu();

    await user.click(await screen.findByRole('button', { name: /LG del living/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo enviar a LG del living. Revisá que esté encendida y en la misma red.',
    );
  });

  // An empty network is an answer. A spinner that never resolves is not.
  it('says the scan found nothing rather than spinning forever', async () => {
    mockedFetchCastDevices.mockResolvedValue([]);
    await openMenu();

    expect(await screen.findByText('No encontramos ningún dispositivo en tu red.')).toBeInTheDocument();
    expect(screen.queryByText('Buscando dispositivos en tu red…')).not.toBeInTheDocument();
  });

  // While the scan is in flight the sheet says so. (Which combination of
  // flags maps to which state is pinned in `deviceListState.test.ts` - as a
  // chain of ternaries in JSX it was not observable from out here at all.)
  it('says it is searching while the scan is in flight', async () => {
    let resolveScan: (devices: CastDevice[]) => void = () => {};
    mockedFetchCastDevices.mockReturnValue(
      new Promise<CastDevice[]>((resolve) => {
        resolveScan = resolve;
      }),
    );
    await openMenu();

    expect(screen.getByText('Buscando dispositivos en tu red…')).toBeInTheDocument();
    expect(screen.queryByText('No encontramos ningún dispositivo en tu red.')).not.toBeInTheDocument();

    resolveScan([LIVING_ROOM]);
    expect(await screen.findByRole('button', { name: /LG del living/ })).toBeInTheDocument();
  });

  it('distinguishes a failed scan from an empty network', async () => {
    mockedFetchCastDevices.mockRejectedValue(new Error('bff down'));
    await openMenu();

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo leer la lista de dispositivos.');
    // Crucially NOT the "nothing found" copy, which would send the user to
    // check a television that is perfectly fine.
    expect(screen.queryByText('No encontramos ningún dispositivo en tu red.')).not.toBeInTheDocument();
  });

  // `OverlayShell` traps Tab inside its own subtree, but the trigger that
  // opened the sheet is a SIBLING of it - so with focus left on the trigger,
  // the first Tab walked out of the dialog into the player controls behind it.
  it('moves focus into the sheet so the trap has something to trap', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    await openMenu();

    const device = await screen.findByRole('button', { name: /LG del living/ });
    expect(device).toHaveFocus();
  });

  // Same rule the Juegos library follows: a background refetch that fails must
  // not hide what we already know is out there.
  it('keeps the devices it found when a re-scan fails', async () => {
    mockedFetchCastDevices.mockResolvedValue([LIVING_ROOM]);
    const user = await openMenu();
    await screen.findByRole('button', { name: /LG del living/ });

    mockedFetchCastDevices.mockRejectedValue(new Error('bff blinked'));
    await user.click(screen.getByRole('button', { name: 'Buscar de nuevo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo actualizar la lista.');
    expect(screen.getByRole('button', { name: /LG del living/ })).toBeInTheDocument();
  });
});
