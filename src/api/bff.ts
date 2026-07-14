import { apiFetch } from '../lib/http/client';
import {
  RegisterResponseSchema,
  type RegisterResponse,
  ListInvitesResponseSchema,
  type Invite,
  CreatedInviteSchema,
  type CreatedInvite,
  ListAdminUsersResponseSchema,
  type AdminUser,
  StorageSchema,
  type Storage,
} from './schemas/bff';

// BFF orchestration client (security hardening: the browser no longer drives
// the multi-step cancel flow itself). Every call here goes through
// `apiFetch('bff', ...)`, which sends the same `connect.sid` cookie as
// Jellyseerr - the BFF authenticates against that session and authorizes the
// action server-side (owner-or-admin for cancel), the same way it already
// gates radarr/sonarr reads/writes.

/**
 * Cancels an in-flight download: the BFF performs the entire orchestration
 * server-side (radarr/sonarr queue delete + unmonitor + Jellyseerr request
 * delete) and returns 204. Replaces the client-side best-effort chain that
 * used to live in `useCancelDownload` (arr resolution, queue cancel,
 * unmonitor, then `deleteRequest` - see git history for the old shape).
 */
export async function cancelDownload(requestId: number, tmdbId: number | null): Promise<void> {
  await apiFetch('bff', '/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, tmdbId }),
  });
}

// ---------------------------------------------------------------------------
// Invite-based self-registration (register spec). `register` is the one
// PUBLIC call in this module - it runs before any session exists - but
// `apiFetch('bff', ...)` unconditionally sends `credentials:'include'` for
// the `bff` backend, which is harmless here (there's no cookie yet).
// ---------------------------------------------------------------------------

export interface RegisterParams {
  code: string;
  username: string;
  password: string;
}

export async function register({ code, username, password }: RegisterParams): Promise<RegisterResponse> {
  return apiFetch('bff', '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, username, password }),
    schema: RegisterResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Admin: invites (Admin screen's "Invitaciones" section)
// ---------------------------------------------------------------------------

export async function listInvites(): Promise<Invite[]> {
  const { invites } = await apiFetch('bff', '/admin/invites', { schema: ListInvitesResponseSchema });
  return invites;
}

export interface CreateInviteParams {
  /** `null`/omitted means the invite never expires. */
  expiresInDays?: number | null;
}

export async function createInvite({ expiresInDays = null }: CreateInviteParams = {}): Promise<CreatedInvite> {
  return apiFetch('bff', '/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresInDays }),
    schema: CreatedInviteSchema,
  });
}

export async function revokeInvite(code: string): Promise<void> {
  await apiFetch('bff', `/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Admin: users (Admin screen's "Usuarios" section)
// ---------------------------------------------------------------------------

export async function listAdminUsers(): Promise<AdminUser[]> {
  const { users } = await apiFetch('bff', '/admin/users', { schema: ListAdminUsersResponseSchema });
  return users;
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  await apiFetch('bff', `/admin/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  });
}

// ---------------------------------------------------------------------------
// Admin: server storage (Admin screen's "Almacenamiento" card)
// ---------------------------------------------------------------------------

export async function getAdminStorage(): Promise<Storage> {
  return apiFetch('bff', '/admin/storage', { schema: StorageSchema });
}
