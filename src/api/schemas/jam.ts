import { z } from 'zod';

// Jam feature schemas — the contract of /bff/jam/*, which this repo owns
// (infra/bff/jam.mjs). Kept in step with that file by hand, same as the music
// schemas track the worker.

export const JamModeSchema = z.enum(['king', 'everyone']);
export const JamRoleSchema = z.enum(['owner', 'controller', 'listener']);

export const JamMemberSchema = z.object({
  // Jellyseerr id as a string. Deliberately not the Jellyfin GUID: the BFF
  // authenticates Jellyseerr ids, so anything else could never be matched back
  // to the person holding the session.
  userId: z.string(),
  name: z.string(),
  role: JamRoleSchema,
  invitedAt: z.number(),
  acceptedAt: z.number().nullable(),
});

export const JamTrackSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  artist: z.string().nullable(),
  coverUrl: z.string().nullable(),
  videoId: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  streamUrl: z.string().nullable().optional(),
  addedBy: z.string(),
});

export const JamPlayheadSchema = z.object({
  index: z.number(),
  positionMs: z.number(),
  isPlaying: z.boolean(),
  /** Server clock when this was last set — followers project forward from it. */
  at: z.number(),
});

export const JamSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: JamModeSchema,
  ownerId: z.string(),
  createdAt: z.number(),
  members: z.array(JamMemberSchema),
  queue: z.array(JamTrackSchema),
  current: JamPlayheadSchema,
  seq: z.number(),
});

/** What the SSE stream pushes and what every write returns: the room, who is
 *  attached, and the server's own answer for who is in charge. The client can
 *  compute `leaderId` itself, but the server's word is what settles a
 *  disagreement. */
export const JamSnapshotSchema = z.object({
  jam: JamSchema,
  present: z.array(z.string()),
  leaderId: z.string().nullable(),
});

export const JamListEntrySchema = JamSnapshotSchema.extend({
  /** This user's own membership row, so the list can separate rooms they are
   *  in from invitations still waiting on them. */
  myRole: JamMemberSchema.optional(),
});

export const JamListResponseSchema = z.object({ jams: z.array(JamListEntrySchema) });
export const JamWriteResponseSchema = z.object({ jam: JamSchema });
export const JamDirectoryResponseSchema = z.object({
  users: z.array(z.object({ userId: z.string(), name: z.string() })),
});
export const JamTimeResponseSchema = z.object({ now: z.number() });

export type JamMode = z.infer<typeof JamModeSchema>;
export type JamRole = z.infer<typeof JamRoleSchema>;
export type JamMember = z.infer<typeof JamMemberSchema>;
export type JamTrack = z.infer<typeof JamTrackSchema>;
export type Jam = z.infer<typeof JamSchema>;
export type JamSnapshot = z.infer<typeof JamSnapshotSchema>;
export type JamListEntry = z.infer<typeof JamListEntrySchema>;
export type JamDirectoryUser = z.infer<typeof JamDirectoryResponseSchema>['users'][number];
