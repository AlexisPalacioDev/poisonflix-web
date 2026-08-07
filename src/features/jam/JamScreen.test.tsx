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
  sendJamTransport,
  setJamMode,
  setJamRole,
  transferJamOwnership,
} from '../../api/jam';
import type { Jam, JamListEntry, JamMember, JamSnapshot } from '../../api/schemas/jam';

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
const mockedSendJamTransport = vi.mocked(sendJamTransport);
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
    mockedSendJamTransport.mockReset();
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

  it('disables transport controls for a listener who is not the effective leader', async () => {
    const jam = jamFixture({
      id: 'jam-listener',
      name: 'Sala escucha',
      ownerId: 'user-owner',
      members: [
        member({ userId: 'user-owner', name: 'Owner', role: 'owner' }),
        member({ userId: OWN_ID, name: 'Yo', role: 'listener' }),
      ],
    });
    // Owner is present, so per `effectiveLeader` the owner outranks the
    // listener regardless of who is also attached.
    const snapshot = snapshotFixture(jam, ['user-owner', OWN_ID], 'user-owner');
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'listener' }))]);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    // The jam row's accessible name is the concatenation of its name AND
    // mode spans (both live inside the same <button>), so target it via its
    // name text then walk up to the button — same pattern DownloadsScreen's
    // tests use for a card whose accessible name isn't the plain title.
    fireEvent.click((await screen.findByText('Sala escucha')).closest('button') as HTMLElement);

    const playButton = await screen.findByRole('button', { name: 'Reproducir' });
    expect(playButton).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
  });

  it('enables transport controls for the effective leader', async () => {
    const jam = jamFixture({
      id: 'jam-leader',
      name: 'Sala líder',
      ownerId: 'user-owner',
      members: [
        member({ userId: 'user-owner', name: 'Owner', role: 'owner' }),
        member({ userId: OWN_ID, name: 'Yo', role: 'controller' }),
      ],
    });
    // Owner absent; the controller present becomes the effective leader, and
    // a controller may always operate transport per `canControlTransport`.
    const snapshot = snapshotFixture(jam, [OWN_ID], OWN_ID);
    mockedListJams.mockResolvedValue([listEntryFixture(jam, member({ userId: OWN_ID, role: 'controller' }))]);
    mockedUseJamStream.mockReturnValue({ snapshot, connected: true, denied: false });

    renderJamScreen();

    fireEvent.click((await screen.findByText('Sala líder')).closest('button') as HTMLElement);

    const playButton = await screen.findByRole('button', { name: 'Reproducir' });
    expect(playButton).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
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

    fireEvent.click((await screen.findByText('Sala propia')).closest('button') as HTMLElement);

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

    fireEvent.click((await screen.findByText('Sala ajena')).closest('button') as HTMLElement);

    expect(await screen.findByRole('button', { name: 'Salir de la Jam' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Buscar usuarios para invitar')).not.toBeInTheDocument();
  });
});
