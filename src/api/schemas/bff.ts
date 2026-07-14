import { z } from 'zod';

// BFF orchestration schemas - register + admin invites/users. Unlike the
// jellyfin/jellyseerr schemas (ported from a Kotlin DTO reference), these
// mirror the BFF's own documented contract directly (infra/bff), which this
// frontend does not own or modify.

// ---------------------------------------------------------------------------
// Register: POST /bff/register (public, no auth)
// ---------------------------------------------------------------------------

export const RegisterResponseSchema = z.object({
  ok: z.literal(true),
  username: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// ---------------------------------------------------------------------------
// Invites: GET/POST /bff/admin/invites, DELETE /bff/admin/invites/{code}
// ---------------------------------------------------------------------------

export const InviteStatusSchema = z.enum(['active', 'used', 'expired']);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;

export const InviteSchema = z.object({
  code: z.string(),
  createdBy: z.number(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  usedBy: z.string().nullable(),
  usedAt: z.string().nullable(),
  status: InviteStatusSchema,
});
export type Invite = z.infer<typeof InviteSchema>;

export const ListInvitesResponseSchema = z.object({
  invites: z.array(InviteSchema),
});
export type ListInvitesResponse = z.infer<typeof ListInvitesResponseSchema>;

// The POST (create) response is the same invite shape minus `status` - a
// freshly created invite is always active, so the BFF doesn't bother sending it.
export const CreatedInviteSchema = z.object({
  code: z.string(),
  createdBy: z.number(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  usedBy: z.string().nullable(),
  usedAt: z.string().nullable(),
});
export type CreatedInvite = z.infer<typeof CreatedInviteSchema>;

// ---------------------------------------------------------------------------
// Users: GET /bff/admin/users, POST /bff/admin/users/{id}/reset-password
// ---------------------------------------------------------------------------

export const AdminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  hasPassword: z.boolean(),
  lastActivityDate: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const ListAdminUsersResponseSchema = z.object({
  users: z.array(AdminUserSchema),
});
export type ListAdminUsersResponse = z.infer<typeof ListAdminUsersResponseSchema>;

// ---------------------------------------------------------------------------
// Admin: server storage (Admin screen's "Almacenamiento" card). Bytes for the
// media disk, sourced from Radarr's /api/v3/diskspace via the BFF.
// ---------------------------------------------------------------------------

export const StorageSchema = z.object({
  path: z.string(),
  freeSpace: z.number(),
  totalSpace: z.number(),
});
export type Storage = z.infer<typeof StorageSchema>;
