import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JamScreen } from './JamScreen';
import { useJamStream } from './useJamStream';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import {
  createJam,
  inviteToJam,
  leaveJam,
  listJamDirectory,
  listJams,
  respondToJamInvite,
  setJamMode,
  setJamRole,
  transferJamOwnership,
} from '../../api/jam';
import type { Jam, JamListEntry, JamMember, JamSnapshot, JamTrack } from '../../api/schemas/jam';

// Pattern mirrors src/hooks/usePersonalMusicFeed.test.tsx: mock the API
// module boundary only, wire the real QueryClient/AuthProvider/session
// store, and assert against what actually renders.

vi.mock('../../api/jam', () => ({
  listJams: vi.fn(),
  listJamDirectory: vi.fn(),
  createJam: vi.fn(),
  inviteToJam: vi.fn(),
  respondToJamInvite: vi.fn(),
  leaveJam: vi.fn(),
  setJamRole: vi.fn(),
  transferJamOwnership: vi.fn(),
  setJamMode: vi.fn(),
  sendJamTransport: vi.fn(),
  // Measuring the clock offset is a real round trip; the room mounts the
  // playback follower, which asks for it on mount.
  measureJamClockOffset: vi.fn().mockResolvedValue(0),
}));
vi.mock('./useJamStream', () => ({ useJamStream: vi.fn() }));

const mockedListJams = vi.mocked(listJams);
const mockedListJamDirectory = vi.mocked(listJamDirectory);
const mockedCreateJam = vi.mocked(createJam);
const mockedInviteToJam = vi.mocked(inviteToJam);
const mockedRespondToJamInvite = vi.mocked(respondToJamInvite);
const mockedLeaveJam = vi.mocked(leaveJam);
const mockedSetJamRole = vi.mocked(setJamRole);
const mockedTransferJamOwnership = vi.mocked(transferJamOwnership);
const mockedSetJamMode = vi.mocked(setJamMode);
const mockedUseJamStream = vi.mocked(useJamStream);

// `ownUserId` is a Jellyseerr id, deliberately distinct in shape from
// `jellyfinUserId` (see JamScreen's module doc comment) — using a clearly
// different string here is what would catch a regression back to reading
// the session's Jellyfin id instead of `myRole.userId`.
const OWN_ID = 'jellyseerr-me';

function member(overrides: Partial<JamMember> & { userId: string; role: JamMember['role'] }): JamMember {
  return { name: overrides.userId, invitedAt: 0, acceptedAt: 0, ...overrides };
}

function jamFixture(overrides: Partial<Jam> & { id: string }): Jam {
  return {
    name: 'Jam',
    mode: 'everyone',
    ownerId: 'someone-else',
    createdAt: 0,
    members: [],
    queue: [],
    current: { index: 0, positionMs: 0, isPlaying: false, at: 0 },
    seq: 0,
    ...overrides,
  };
}

function trackFixture(title: string): JamTrack {
  return { itemId: `item-${title}`, title, artist: 'Alguien', coverUrl: null, addedBy: OWN_ID };
}

function snapshotFixture(jam: Jam, present: string[], leaderId: string | null): JamSnapshot {
  return { jam, present, leaderId };
}

function listEntryFixture(jam: Jam, myRole: JamMember | undefined): JamListEntry {
  return { jam, present: [], leaderId: null, myRole };
}

function renderJamScreen() {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'jellyfin-guid-unrelated', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/jam']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <JamScreen />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('JamScreen', () => {
  afterEach(() => {
    cleanup();
    clearSession();
    mockedListJams.mockReset();
    mockedListJamDirectory.mockReset();
    mockedCreateJam.mockReset();
    mockedInviteToJam.mockReset();
    mockedRespondToJamInvite.mockReset();
    mockedLeaveJam.mockReset();
    mockedSetJamRole.mockReset();
    mockedTransferJamOwnership.mockReset();
    mockedSetJamMode.mockReset();
    mockedUseJamStream.mockReset();
  });

  it('shows a pending invitation with Aceptar, and accepting calls respondToJamInvite(jamId, true)', async () => {
    const jam = jamFixture({ id: 'jam-invite', name: 'Sala de invitación' });
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'listener', acceptedAt: null }))]);
    mockedRespondToJamInvite.mockResolvedValue(jam);
    mockedUseJamStream.mockReturnValue({ snapshot: null, connected: false, denied: false });

    renderJamScreen();

    expect(await screen.findByText('Sala de invitación')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Aceptar' });

    fireEvent.click(accept);

    // `mutate()` invokes the (async) mutationFn a tick later, not
    // synchronously within the click handler — same reason every other
    // real-`useMutation` assertion in this suite goes through `waitFor`.
    await waitFor(() => expect(mockedRespondToJamInvite).toHaveBeenCalledWith('jam-invite', true));
  });

  // The owner's complaint, as a regression guard: "si yo entro a
  // configuraciones de jam solo deberia estar las configuraciones, no la lista
  // de reproduccion ni las canciones". The queue and the transport belong to
  // Música and to the global now-playing bar respectively; neither may come
  // back onto this screen.
  it('shows no queue and no transport controls — the room screen is settings only', async () => {
    const jam = jamFixture({
      id: 'jam-quiet',
      name: 'Sala silenciosa',
      ownerId: OWN_ID,
      members: [member({ userId: OWN_ID, name: 'Yo', role: 'owner' })],
      queue: [trackFixture('Cancion Secreta'), trackFixture('Otra Cancion')],
    });
    const snapshot = snapshotFixture(jam, [OWN_ID], OWN_ID);
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'owner' }))]);
    mockedListJamDirectory.mockResolvedValue([]);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala silenciosa') }));

    // The room header renders, so we are inside the room and not still on the list.
    expect(await screen.findByRole('heading', { name: 'Sala silenciosa' })).toBeInTheDocument();

    expect(screen.queryByText('Cancion Secreta')).not.toBeInTheDocument();
    expect(screen.queryByText('Otra Cancion')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cola' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reproducir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Anterior' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Siguiente' })).not.toBeInTheDocument();

    // …and the way to add music is still one tap away, pointing at Música.
    expect(screen.getByRole('button', { name: 'Poner música' })).toBeInTheDocument();
  });

  // The native <select> this replaced was painted and positioned by the OS,
  // which on a dark theme meant white options rendered off the edge of a
  // phone. Both options are now visible rows in a radiogroup.
  it('lets the owner switch the mode from a radio row, with no native select', async () => {
    const jam = jamFixture({
      id: 'jam-mode',
      name: 'Sala modo',
      mode: 'everyone',
      ownerId: OWN_ID,
      members: [member({ userId: OWN_ID, name: 'Yo', role: 'owner' })],
    });
    const snapshot = snapshotFixture(jam, [OWN_ID], OWN_ID);
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'owner' }))]);
    mockedListJamDirectory.mockResolvedValue([]);
    mockedSetJamMode.mockResolvedValue(jam);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    const { container } = renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala modo') }));

    const everyone = await screen.findByRole('radio', { name: /Todos los dispositivos suenan/ });
    expect(everyone).toHaveAttribute('aria-checked', 'true');
    expect(container.querySelector('select')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Solo mi dispositivo suena/ }));

    await waitFor(() => expect(mockedSetJamMode).toHaveBeenCalledWith('jam-mode', 'king'));
  });

  // Two actions on a two-person list do not earn a "⋮": both chips are on the
  // row, readable without a tap. This test is the guard against them being
  // hidden behind a menu again.
  it('gives control to another member from a chip on the row, with no overflow menu', async () => {
    const jam = jamFixture({
      id: 'jam-roles',
      name: 'Sala roles',
      ownerId: OWN_ID,
      members: [
        member({ userId: OWN_ID, name: 'Yo', role: 'owner' }),
        member({ userId: 'user-friend', name: 'Amigo', role: 'listener' }),
      ],
    });
    const snapshot = snapshotFixture(jam, [OWN_ID, 'user-friend'], OWN_ID);
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'owner' }))]);
    mockedListJamDirectory.mockResolvedValue([]);
    mockedSetJamRole.mockResolvedValue(jam);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala roles') }));

    // Both actions are readable on the row, with nothing to open first…
    const giveControl = await screen.findByRole('button', { name: 'Dar control' });
    expect(giveControl).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pasarle la sala' })).toBeInTheDocument();

    // …and there is no ⋮ hiding them, for anyone on the list.
    expect(screen.queryByRole('button', { name: /^Opciones de / })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();

    // Only the other person gets them: the owner cannot demote or replace
    // themselves, so their own row carries exactly one of each — the friend's.
    expect(screen.getAllByRole('button', { name: 'Dar control' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Pasarle la sala' })).toHaveLength(1);

    fireEvent.click(giveControl);

    await waitFor(() =>
      expect(mockedSetJamRole).toHaveBeenCalledWith('jam-roles', 'user-friend', 'controller'),
    );
  });

  // The mirror of the chip above: someone who already controls the music gets
  // the chip that takes it back, not a second copy of the one that grants it.
  it('offers "Quitar control" for a member who already has it', async () => {
    const jam = jamFixture({
      id: 'jam-roles-off',
      name: 'Sala roles quitar',
      ownerId: OWN_ID,
      members: [
        member({ userId: OWN_ID, name: 'Yo', role: 'owner' }),
        member({ userId: 'user-friend', name: 'Amigo', role: 'controller' }),
      ],
    });
    const snapshot = snapshotFixture(jam, [OWN_ID, 'user-friend'], OWN_ID);
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'owner' }))]);
    mockedListJamDirectory.mockResolvedValue([]);
    mockedSetJamRole.mockResolvedValue(jam);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala roles quitar') }));

    fireEvent.click(await screen.findByRole('button', { name: 'Quitar control' }));

    await waitFor(() =>
      expect(mockedSetJamRole).toHaveBeenCalledWith('jam-roles-off', 'user-friend', 'listener'),
    );
  });

  // A guest sees the room, never its levers — the chips are the owner's alone.
  it('shows no member action chips to a non-owner', async () => {
    const jam = jamFixture({
      id: 'jam-guest-chips',
      name: 'Sala sin chips',
      ownerId: 'user-owner',
      members: [
        member({ userId: 'user-owner', name: 'Owner', role: 'owner' }),
        member({ userId: OWN_ID, name: 'Yo', role: 'listener' }),
      ],
    });
    const snapshot = snapshotFixture(jam, ['user-owner', OWN_ID], 'user-owner');
    mockedListJams.mockResolvedValue([
      listEntryFixture(jam, member({ userId: OWN_ID, role: 'listener' })),
    ]);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala sin chips') }));

    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dar control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quitar control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pasarle la sala' })).not.toBeInTheDocument();
  });

  it('shows the user search for the owner', async () => {
    const jam = jamFixture({
      id: 'jam-owned',
      name: 'Sala propia',
      ownerId: OWN_ID,
      members: [member({ userId: OWN_ID, name: 'Yo', role: 'owner' })],
    });
    const snapshot = snapshotFixture(jam, [OWN_ID], OWN_ID);
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'owner' }))]);
    mockedListJamDirectory.mockResolvedValue([]);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala propia') }));

    expect(await screen.findByLabelText('Buscar usuarios para invitar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salir de la Jam' })).not.toBeInTheDocument();
  });

  it('hides the user search and shows "Salir de la Jam" for a non-owner', async () => {
    const jam = jamFixture({
      id: 'jam-guest',
      name: 'Sala ajena',
      ownerId: 'user-owner',
      members: [
        member({ userId: 'user-owner', name: 'Owner', role: 'owner' }),
        member({ userId: OWN_ID, name: 'Yo', role: 'listener' }),
      ],
    });
    const snapshot = snapshotFixture(jam, ['user-owner', OWN_ID], 'user-owner');
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'listener' }))]);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp('Sala ajena') }));

    expect(await screen.findByRole('button', { name: 'Salir de la Jam' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Buscar usuarios para invitar')).not.toBeInTheDocument();
  });
});
