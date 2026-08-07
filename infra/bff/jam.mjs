// Jam: listening together. File-backed like `invites.mjs`, zero runtime
// dependencies, and the first push channel this codebase has ever had.
//
// Three ideas carry the whole design.
//
// 1. LEADERSHIP IS DERIVED, NEVER STORED. The owner asked for the leader
//    leaving to hand the room over, for granted controllers to get first
//    refusal, and for the creator to take the room back on return. Stored,
//    those are three events to persist, broadcast and reconcile — each racy,
//    and all of them wrong after a restart that remembers a leader who is not
//    there. Computed from presence they are one rule read at three moments,
//    and a restart is self-healing because nobody is present, which is true.
//
// 2. THE SSE CONNECTION IS THE PRESENCE. There is no separate heartbeat to
//    keep honest and no "am I still here" endpoint to forget to call. Open a
//    stream and you are in the room; drop it and you are not. This also
//    dissolves the question of whether navigating home counts as leaving:
//    it does, because the stream closes, and coming back reopens it.
//
// 3. THE SERVER SEQUENCES COMMANDS. Two controllers pressing pause at the
//    same instant is settled by whichever the server applied last. Clients
//    render the snapshot that comes back rather than their own guess, so they
//    cannot disagree about what is playing.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const FILE = process.env.JAM_FILE || '/data/jams.json';

// A queue nobody can see the end of is a memory leak with a UI. Generous
// enough that nobody will meet it during a road trip.
const MAX_QUEUE = 500;
const MAX_MEMBERS = 25;

// Ceiling on the serialised queue. The per-field caps bound one track; this
// bounds the room, which is what actually gets written to the shared file and
// pushed down every open stream on every change.
const MAX_QUEUE_BYTES = 256 * 1024;

// Open streams one person may hold on one room. Several tabs and a phone is
// ordinary; more than this is a bug or an attack, and each one costs a socket
// and a heartbeat timer until it closes.
const MAX_STREAMS_PER_USER = 8;

/** Serializes every read-modify-write, same reason as invites.mjs: `await`
 *  inside a handler yields the event loop, so two requests can interleave. */
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function load() {
  try {
    const raw = await readFile(FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.jams) ? data.jams : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function persist(jams) {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ jams }, null, 2), 'utf8');
  await rename(tmp, FILE); // atomic swap; a crash mid-write cannot corrupt it
}

// ---------------------------------------------------------------------------
// Rules — pure, and mirrored in src/lib/domain/jam.ts for the client.
// ---------------------------------------------------------------------------

/** Members who accepted, oldest first. Ordered by acceptance rather than
 *  invitation so the tie-break matches the order people actually walked in. */
function seated(jam) {
  return jam.members
    .filter((m) => m.acceptedAt !== null)
    .slice()
    .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0));
}

/** Who is running the room right now: the owner if present, else a granted
 *  controller, else whoever is there, else nobody. */
export function effectiveLeader(jam, present) {
  const inRoom = seated(jam).filter((m) => present.has(m.userId));
  const owner = inRoom.find((m) => m.userId === jam.ownerId);
  if (owner) return owner.userId;
  const controller = inRoom.find((m) => m.role === 'controller');
  if (controller) return controller.userId;
  return inRoom[0]?.userId ?? null;
}

/** Transport is for the acting leader and anyone the owner granted control to.
 *  Presence is required even of the owner: you cannot pause what you left. */
export function canControlTransport(jam, present, userId) {
  if (!present.has(userId)) return false;
  const member = seated(jam).find((m) => m.userId === userId);
  if (!member) return false;
  return member.role === 'controller' || effectiveLeader(jam, present) === userId;
}

/** Any accepted member, attached or not — membership outlives presence. */
export function canQueue(jam, userId) {
  return seated(jam).some((m) => m.userId === userId);
}

/** Only the room's owner reshapes the room itself: who is in it, who holds
 *  control, which mode it runs in. An acting leader runs the music, not the
 *  guest list -- otherwise the owner stepping out for ten minutes would be
 *  enough for someone else to hand out permissions in their name. */
function isOwner(jam, userId) {
  return jam.ownerId === userId;
}

// ---------------------------------------------------------------------------
// Presence + subscribers. Both in memory on purpose: a restart means nobody is
// connected, which is exactly the truth, and this BFF is a single instance.
// ---------------------------------------------------------------------------

/** jamId -> Map<userId, Set<res>>. A user with two tabs open is present once
 *  and stays present until the last of them closes. */
const streams = new Map();

function presenceOf(jamId) {
  const byUser = streams.get(jamId);
  return new Set(byUser ? byUser.keys() : []);
}

function snapshot(jam) {
  const present = presenceOf(jam.id);
  return {
    jam,
    present: [...present],
    leaderId: effectiveLeader(jam, present),
  };
}

function broadcast(jam) {
  const byUser = streams.get(jam.id);
  if (!byUser) return;
  const payload = `data: ${JSON.stringify(snapshot(jam))}\n\n`;
  for (const responses of byUser.values()) {
    for (const res of responses) {
      try {
        res.write(payload);
      } catch {
        // A dead socket is cleaned up by its own 'close' handler; failing to
        // write to one must never stop the others from being told.
      }
    }
  }
}

/**
 * Attach a live SSE response to a jam. Returns a detach function.
 *
 * Attaching and detaching both re-broadcast, because either can change who the
 * leader is — that is the whole point of deriving it from presence.
 */
export function attach(jamId, userId, res) {
  let byUser = streams.get(jamId);
  if (!byUser) {
    byUser = new Map();
    streams.set(jamId, byUser);
  }
  let responses = byUser.get(userId);
  if (!responses) {
    responses = new Set();
    byUser.set(userId, responses);
  }
  // A few tabs is normal, a thousand is not. Each held connection costs a
  // socket and a heartbeat timer for as long as it lives, and nothing else in
  // this server bounds them.
  if (responses.size >= MAX_STREAMS_PER_USER) return null;
  responses.add(res);

  let detached = false;
  return function detach() {
    if (detached) return; // 'close' can fire more than once
    detached = true;
    responses.delete(res);
    if (responses.size === 0) byUser.delete(userId);
    if (byUser.size === 0) streams.delete(jamId);
    void getJam(jamId).then((jam) => {
      if (jam) broadcast(jam);
    });
  };
}

/** The snapshot a freshly-attached client should be sent immediately, so it
 *  renders the room without waiting for someone else to change something. */
export async function currentSnapshot(jamId) {
  const jam = await getJam(jamId);
  return jam ? snapshot(jam) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getJam(jamId) {
  return withLock(async () => {
    const jams = await load();
    return jams.find((j) => j.id === jamId) ?? null;
  });
}

/** Every jam this user belongs to, accepted or still pending. Pending ones are
 *  how the invitation reaches them: there is no separate inbox to keep in
 *  step with the membership list. */
export function listJamsForUser(userId) {
  return withLock(async () => {
    const jams = await load();
    return jams
      .filter((j) => j.members.some((m) => m.userId === userId))
      .map((j) => ({
        ...snapshot(j),
        myRole: j.members.find((m) => m.userId === userId),
      }));
  });
}

// ---------------------------------------------------------------------------
// Writes. Every one returns { ok, reason?, jam? } rather than throwing, so the
// route layer maps reasons to status codes in one place.
// ---------------------------------------------------------------------------

function mutate(jamId, fn) {
  return withLock(async () => {
    const jams = await load();
    const jam = jams.find((j) => j.id === jamId);
    if (!jam) return { ok: false, reason: 'not_found' };
    const outcome = fn(jam, presenceOf(jamId));
    if (outcome && outcome.ok === false) return outcome;
    jam.seq += 1;
    await persist(jams);
    broadcast(jam);
    return { ok: true, jam };
  });
}

export function createJam({ ownerId, ownerName, name, mode }) {
  return withLock(async () => {
    const jams = await load();
    const now = Date.now();
    const jam = {
      id: randomUUID(),
      name: String(name || 'Jam').slice(0, 60),
      mode: mode === 'everyone' ? 'everyone' : 'king',
      ownerId,
      createdAt: now,
      members: [
        {
          userId: ownerId,
          name: ownerName,
          role: 'owner',
          invitedAt: now,
          // The creator is in the room from the first instant; making them
          // accept their own invitation would be theatre.
          acceptedAt: now,
        },
      ],
      queue: [],
      current: { index: 0, positionMs: 0, isPlaying: false, at: now },
      seq: 0,
    };
    jams.push(jam);
    await persist(jams);
    return { ok: true, jam };
  });
}

export function inviteMembers(jamId, byUserId, invitees) {
  return mutate(jamId, (jam) => {
    if (!isOwner(jam, byUserId)) return { ok: false, reason: 'forbidden' };
    const now = Date.now();
    for (const invitee of invitees) {
      const userId = String(invitee.userId);
      if (jam.members.some((m) => m.userId === userId)) continue; // re-invite is a no-op
      if (jam.members.length >= MAX_MEMBERS) return { ok: false, reason: 'jam_full' };
      jam.members.push({
        userId,
        name: String(invitee.name || userId).slice(0, 60),
        role: 'listener',
        invitedAt: now,
        acceptedAt: null,
      });
    }
  });
}

export function respondToInvite(jamId, userId, accept) {
  return mutate(jamId, (jam) => {
    const member = jam.members.find((m) => m.userId === userId);
    if (!member) return { ok: false, reason: 'not_invited' };
    if (member.acceptedAt !== null) return { ok: false, reason: 'already_member' };
    if (!accept) {
      jam.members = jam.members.filter((m) => m.userId !== userId);
      return;
    }
    member.acceptedAt = Date.now();
  });
}

/** Leaving is permanent and deliberate, unlike closing the stream. The owner
 *  cannot leave their own room -- they transfer it or it stays theirs. */
export function leaveJam(jamId, userId) {
  return mutate(jamId, (jam) => {
    if (isOwner(jam, userId)) return { ok: false, reason: 'owner_cannot_leave' };
    if (!jam.members.some((m) => m.userId === userId)) return { ok: false, reason: 'not_member' };
    jam.members = jam.members.filter((m) => m.userId !== userId);
  });
}

/** The owner's only recourse against someone who will not behave. Without it,
 *  `leaveJam` was the sole way out of a room and only the member themself
 *  could call it — so a guest who kept clearing the queue could not be
 *  removed by anyone. */
export function removeMember(jamId, byUserId, targetUserId) {
  return mutate(jamId, (jam) => {
    if (!isOwner(jam, byUserId)) return { ok: false, reason: 'forbidden' };
    if (targetUserId === jam.ownerId) return { ok: false, reason: 'cannot_remove_owner' };
    if (!jam.members.some((m) => m.userId === targetUserId)) {
      return { ok: false, reason: 'not_member' };
    }
    jam.members = jam.members.filter((m) => m.userId !== targetUserId);
  });
}

export function setRole(jamId, byUserId, targetUserId, role) {
  return mutate(jamId, (jam) => {
    if (!isOwner(jam, byUserId)) return { ok: false, reason: 'forbidden' };
    if (targetUserId === jam.ownerId) return { ok: false, reason: 'cannot_demote_owner' };
    if (role !== 'controller' && role !== 'listener') return { ok: false, reason: 'bad_role' };
    const member = seated(jam).find((m) => m.userId === targetUserId);
    if (!member) return { ok: false, reason: 'not_member' };
    member.role = role;
  });
}

/** Hand the crown over for good. Distinct from the acting leadership that
 *  presence confers and takes back -- this one does not revert. */
export function transferOwnership(jamId, byUserId, targetUserId) {
  return mutate(jamId, (jam) => {
    if (!isOwner(jam, byUserId)) return { ok: false, reason: 'forbidden' };
    const target = seated(jam).find((m) => m.userId === targetUserId);
    if (!target) return { ok: false, reason: 'not_member' };
    const previous = jam.members.find((m) => m.userId === byUserId);
    // The former owner keeps control rather than dropping to listener: they
    // were running the room a moment ago and taking that away silently would
    // read as a bug.
    if (previous) previous.role = 'controller';
    target.role = 'owner';
    jam.ownerId = targetUserId;
  });
}

export function setMode(jamId, byUserId, mode) {
  return mutate(jamId, (jam) => {
    if (!isOwner(jam, byUserId)) return { ok: false, reason: 'forbidden' };
    if (mode !== 'king' && mode !== 'everyone') return { ok: false, reason: 'bad_mode' };
    jam.mode = mode;
  });
}

/**
 * `replace` is what "play" means when a Jam is the chosen output: the room
 * stops what it was doing and starts this instead. That is a transport act,
 * not a queue act, so it takes transport rights — anyone may add to the end of
 * what everyone is hearing, but replacing it is the same power as pressing
 * next, and is gated the same way.
 */
export function addTracks(jamId, userId, tracks, replace = false) {
  return mutate(jamId, (jam, present) => {
    if (!canQueue(jam, userId)) return { ok: false, reason: 'forbidden' };
    if (replace && !canControlTransport(jam, present, userId)) {
      return { ok: false, reason: 'forbidden' };
    }
    const already = replace ? 0 : jam.queue.length;
    if (already + tracks.length > MAX_QUEUE) return { ok: false, reason: 'queue_full' };
    const staged = tracks.map((track) => ({
      // Every string is capped. `itemId` and `videoId` were not, and that was
      // enough on its own: one member could push a megabyte-long id, and since
      // `persist` rewrites the single shared jams.json on every mutation of
      // ANY room and `broadcast` re-sends the whole snapshot to everyone
      // present, one inflated queue degrades the feature for all of it.
      itemId: String(track.itemId ?? '').slice(0, 200),
      title: String(track.title || '').slice(0, 200),
      artist: track.artist ? String(track.artist).slice(0, 200) : null,
      coverUrl: track.coverUrl ? String(track.coverUrl).slice(0, 500) : null,
      videoId: track.videoId ? String(track.videoId).slice(0, 200) : null,
      durationSeconds: Number.isFinite(track.durationSeconds) ? track.durationSeconds : null,
      streamUrl: track.streamUrl ? String(track.streamUrl).slice(0, 500) : null,
      addedBy: userId,
    }));
    if (staged.some((track) => !track.itemId)) return { ok: false, reason: 'bad_track' };
    // A count limit is not a size limit: 500 tracks of capped-but-large
    // strings still add up, and the file is shared. Measure what will actually
    // be written rather than trusting the per-field caps to compose.
    const base = replace ? [] : jam.queue;
    const projected = JSON.stringify([...base, ...staged]).length;
    if (projected > MAX_QUEUE_BYTES) return { ok: false, reason: 'queue_full' };
    if (replace) {
      jam.queue = staged;
      jam.current = { index: 0, positionMs: 0, isPlaying: true, at: Date.now() };
      return;
    }
    jam.queue.push(...staged);
  });
}

/** Removing is not the mirror of adding: anyone may queue, but a track is only
 *  removable by the person who put it there or by someone entitled to drive.
 *  Without that, one listener could keep emptying a queue everyone else is
 *  building and the room would have no recourse. */
export function removeTrack(jamId, userId, index) {
  return mutate(jamId, (jam, present) => {
    if (!canQueue(jam, userId)) return { ok: false, reason: 'forbidden' };
    if (!Number.isInteger(index) || index < 0 || index >= jam.queue.length) {
      return { ok: false, reason: 'bad_index' };
    }
    const track = jam.queue[index];
    if (track.addedBy !== userId && !canControlTransport(jam, present, userId)) {
      return { ok: false, reason: 'not_yours' };
    }
    jam.queue.splice(index, 1);
    // Keep the playhead pointing at the same song rather than at whatever slid
    // into its slot: removing track 2 must not skip the room forward.
    if (index < jam.current.index) jam.current.index -= 1;
    else if (index === jam.current.index) {
      jam.current.positionMs = 0;
      jam.current.at = Date.now();
      if (jam.current.index >= jam.queue.length) jam.current.index = Math.max(0, jam.queue.length - 1);
    }
  });
}

/**
 * Transport. `at` is stamped with the server's clock on every change so
 * followers in `everyone` mode project the position forward from a time they
 * can measure their offset against, instead of trusting when they think the
 * message was sent.
 */
export function transport(jamId, userId, command) {
  return mutate(jamId, (jam, present) => {
    if (!canControlTransport(jam, present, userId)) return { ok: false, reason: 'forbidden' };
    const now = Date.now();
    const last = jam.queue.length - 1;
    switch (command.type) {
      case 'play':
        jam.current.isPlaying = true;
        break;
      case 'pause':
        // Freeze at where playback actually is, not where it was last set,
        // or every pause would rewind to the last command.
        jam.current.positionMs = projectedPositionMs(jam, now);
        jam.current.isPlaying = false;
        break;
      case 'next':
        if (jam.current.index >= last) return { ok: false, reason: 'end_of_queue' };
        jam.current.index += 1;
        jam.current.positionMs = 0;
        break;
      case 'prev':
        if (jam.current.index <= 0) return { ok: false, reason: 'start_of_queue' };
        jam.current.index -= 1;
        jam.current.positionMs = 0;
        break;
      case 'jump': {
        const index = command.index;
        if (!Number.isInteger(index) || index < 0 || index > last) {
          return { ok: false, reason: 'bad_index' };
        }
        jam.current.index = index;
        jam.current.positionMs = 0;
        break;
      }
      case 'seek': {
        const positionMs = Number(command.positionMs);
        if (!Number.isFinite(positionMs) || positionMs < 0) return { ok: false, reason: 'bad_position' };
        jam.current.positionMs = Math.round(positionMs);
        break;
      }
      default:
        return { ok: false, reason: 'bad_command' };
    }
    jam.current.at = now;
  });
}

/** Where playback is now, given when it was last set. Exported because both
 *  the pause path and any follower need the same arithmetic. */
export function projectedPositionMs(jam, now = Date.now()) {
  if (!jam.current.isPlaying) return jam.current.positionMs;
  return jam.current.positionMs + Math.max(0, now - jam.current.at);
}
