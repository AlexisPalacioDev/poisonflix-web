import { apiFetch } from '../lib/http/client';
import {
  JamDirectoryResponseSchema,
  JamListResponseSchema,
  JamTimeResponseSchema,
  JamWriteResponseSchema,
  type Jam,
  type JamDirectoryUser,
  type JamListEntry,
  type JamMode,
} from './schemas/jam';

// Client for /bff/jam/*. Every write returns the whole room rather than a
// patch: rooms are small, and a client that reconstructs state from deltas can
// drift from the server, which is the one thing a shared queue must never do.

export async function listJams(): Promise<JamListEntry[]> {
  const { jams } = await apiFetch('bff', '/jam', { schema: JamListResponseSchema });
  return jams;
}

/** Who this user could invite. Minimal on purpose — id and name, nothing that
 *  turns a search box into a way to learn about other accounts. */
export async function listJamDirectory(): Promise<JamDirectoryUser[]> {
  const { users } = await apiFetch('bff', '/jam/users', { schema: JamDirectoryResponseSchema });
  return users;
}

async function write(path: string, body: unknown): Promise<Jam> {
  const { jam } = await apiFetch('bff', path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    schema: JamWriteResponseSchema,
  });
  return jam;
}

export function createJam(input: { name: string; mode: JamMode }): Promise<Jam> {
  return write('/jam', input);
}

export function inviteToJam(jamId: string, users: Array<{ userId: string; name: string }>) {
  return write(`/jam/${encodeURIComponent(jamId)}/invite`, { users });
}

export function respondToJamInvite(jamId: string, accept: boolean) {
  return write(`/jam/${encodeURIComponent(jamId)}/respond`, { accept });
}

export function leaveJam(jamId: string) {
  return write(`/jam/${encodeURIComponent(jamId)}/leave`, {});
}

/** Grant or take back transport control. The owner's own row cannot be changed
 *  this way — the crown moves with `transferJamOwnership`. */
export function setJamRole(jamId: string, userId: string, role: 'controller' | 'listener') {
  return write(`/jam/${encodeURIComponent(jamId)}/role`, { userId, role });
}

export function transferJamOwnership(jamId: string, userId: string) {
  return write(`/jam/${encodeURIComponent(jamId)}/owner`, { userId });
}

export function setJamMode(jamId: string, mode: JamMode) {
  return write(`/jam/${encodeURIComponent(jamId)}/mode`, { mode });
}

export function addTracksToJam(jamId: string, tracks: unknown[]) {
  return write(`/jam/${encodeURIComponent(jamId)}/queue`, { tracks });
}

export function removeTrackFromJam(jamId: string, index: number) {
  return write(`/jam/${encodeURIComponent(jamId)}/unqueue`, { index });
}

export type JamTransportCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'jump'; index: number }
  | { type: 'seek'; positionMs: number };

export function sendJamTransport(jamId: string, command: JamTransportCommand) {
  return write(`/jam/${encodeURIComponent(jamId)}/transport`, command);
}

/**
 * Offset between this device's clock and the server's, in milliseconds.
 *
 * Measured NTP-style: several round trips, keep the fastest, because the
 * fastest is the one least distorted by a queue somewhere in the middle. Only
 * `everyone` mode needs this — in `king` mode a single device makes the sound
 * and there is nothing to agree with.
 *
 * On a phone this is the difference between two helmets hearing the same bar
 * and hearing it a second apart, so it is worth the four extra requests.
 */
export async function measureJamClockOffset(samples = 4): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  let offset = 0;
  for (let i = 0; i < samples; i += 1) {
    const sent = Date.now();
    const { now } = await apiFetch('bff', '/jam/time', { schema: JamTimeResponseSchema });
    const received = Date.now();
    const roundTrip = received - sent;
    if (roundTrip < best) {
      best = roundTrip;
      // Assume the reply took half the round trip to come back.
      offset = now + roundTrip / 2 - received;
    }
  }
  return Math.round(offset);
}
