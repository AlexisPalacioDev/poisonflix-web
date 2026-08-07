// Jam: listening together. Everything here is pure, so the rules that decide
// who is in charge of a room can be read, tested and reasoned about without a
// socket, a server or a clock — same discipline as `musicTaste.ts`.
//
// The one idea worth understanding before reading any of it: LEADERSHIP IS NOT
// STORED. It is computed from who is currently connected.
//
// The owner described three behaviours — the leader leaving hands the room to
// someone else, controllers get first refusal, and the creator takes the room
// back the moment they return. Stored as state, those are three events to
// persist, broadcast and reconcile, each with its own race, and all of them
// wrong after a BFF restart (which remembers a leader who is no longer there).
// Derived from presence, they are one rule read at three moments, and a
// restart is self-healing: nobody is present, which is the truth.

// The shapes come from the wire contract rather than being declared again
// here, exactly as `musicTaste.ts` takes its types from `api/schemas/music`.
// Declaring a second `Jam` interface alongside the zod-inferred one produced
// two different types with the same name, and since `tsconfig.app.json` does
// not enable `strict`, zod infers every field as optional under it — so the
// two only failed to line up during `npm run build`, never under a bare
// `tsc --noEmit`. One source for the shape, this file for the rules.
import type { Jam, JamMember } from '../../api/schemas/jam';

export type { Jam, JamMember, JamMode, JamRole, JamTrack } from '../../api/schemas/jam';

/** Members who accepted, oldest first. Ordering is by acceptance rather than
 *  invitation so the tie-break matches the order people actually walked in. */
function seated(jam: Jam): JamMember[] {
  return jam.members
    .filter((member) => member.acceptedAt !== null)
    .slice()
    .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0));
}

/**
 * Who is running the room right now.
 *
 * The owner outranks everyone whenever they are present — that is what makes
 * "el líder anterior recupera el liderazgo al volver" free rather than a
 * hand-back protocol. Below them, a granted controller, because the owner
 * asked for controllers to be preferred. Below that, whoever is there, since a
 * room with people in it should never be leaderless. An empty room has no
 * leader, and that is not a failure: a Jam outlives everyone leaving it.
 */
export function effectiveLeader(jam: Jam, present: ReadonlySet<string>): string | null {
  const inRoom = seated(jam).filter((member) => present.has(member.userId));
  const owner = inRoom.find((member) => member.userId === jam.ownerId);
  if (owner) return owner.userId;
  const controller = inRoom.find((member) => member.role === 'controller');
  if (controller) return controller.userId;
  return inRoom[0]?.userId ?? null;
}

/**
 * May this person press play, pause, next or seek?
 *
 * The acting leader, plus anyone the owner granted control to — that grant is
 * exactly what lets the owner share the wheel without giving up the room.
 *
 * Presence is required even for the owner. Transport acts on playback
 * happening right now; someone who is not attached cannot hear what they would
 * be interrupting, and in `king` mode they are not even the device making the
 * sound.
 */
export function canControlTransport(
  jam: Jam,
  present: ReadonlySet<string>,
  userId: string,
): boolean {
  if (!present.has(userId)) return false;
  const member = seated(jam).find((candidate) => candidate.userId === userId);
  if (!member) return false;
  return member.role === 'controller' || effectiveLeader(jam, present) === userId;
}

/**
 * May this person add to the queue?
 *
 * Any member who accepted, whether or not they are attached. Membership
 * outlives presence by design — someone back on the home screen listening to
 * their own music is still in the Jam, and lining up a track for later is the
 * most ordinary thing they might want to do from there.
 */
export function canQueue(jam: Jam, userId: string): boolean {
  return seated(jam).some((member) => member.userId === userId);
}
