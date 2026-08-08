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

// How long after the nominal end of a track the server steps in and advances
// the queue itself. A second, rather than zero, because the client that is
// actually making sound is the better authority on when its own audio ended
// and this is only the backstop for when no such client exists. A second late
// is inaudible; a second early would fight the client for every song.
const SERVER_ADVANCE_GRACE_MS = 1_000;

// How long a client's `next` is treated as a report about the track the server
// has ALREADY moved off, rather than as a request to skip the new one. The
// client sends a bare `{type:'next'}` on `ended` with no index in it, so this
// window is the only thing separating "the song you were on finished" from
// "skip this song".
//
// It does not have to cover a client noticing the end late — only the flight
// time of a request that was already sent. A client that receives the
// broadcast for an advance reassigns `audio.src` and calls `load()`
// (useJamPlayback.ts), and `load()` aborts playback without firing `ended`, so
// once a client has heard about the advance it will never report it. Five
// seconds is generous for a request in flight over a bad phone connection.
//
// Beyond it, a report that late is indistinguishable from a person pressing
// the button, and is obeyed. And exactly one `next` per auto-advance is ever
// swallowed, so a real double-press always lands.
const CLIENT_NEXT_GRACE_MS = 5_000;

// How long an emptied room keeps playing before the server freezes it.
//
// Not zero, which is what the first attempt did, and it was wrong twice over.
// `EventSource` reconnects on its own after a network dip — 3 s is the browser
// default and a failed attempt doubles it — so the lone listener riding
// through a tunnel came back to a room that had paused and resumed behind
// them, three seconds adrift, with an audible jump backwards. And navigating
// between screens unmounts and remounts the stream host, so every trip to the
// library was a pause plus a resume: two writes to the file every other room
// shares, for a person who never left.
//
// Ten seconds swallows a reconnect and one retry. A room truly abandoned plays
// on for ten seconds with nobody there, which costs nothing.
const EMPTY_ROOM_GRACE_MS = 10_000;

// The queue cannot be walked more times than it has entries, so this is only a
// guard against a duration this file has not thought of. It never freezes the
// room: a run that hits the cap leaves the state further along than it found
// it, and the next read picks up where this one gave up.
const MAX_ADVANCE_STEPS = MAX_QUEUE + 1;

/**
 * Every wait and every reading of the wall clock in this module goes through
 * here, so a test can drive time instead of racing it. Asserting that
 * something did NOT happen by sleeping and looking is a bet on how fast the
 * machine is, not a statement about the code.
 *
 * It earns its keep in production too: `unref` in one place means no timer
 * this file arms can hold the process open for a room nobody is in.
 */
export const clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

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
// The playhead is a free-running clock, and something has to stop it
//
// A room's position is `positionMs` plus however long it has been since `at`.
// Nothing made this server aware of how long a track lasts, so the end of one
// was reported by whichever client was making sound, over `next`. When no such
// client existed — the room screen open with autoplay refused, a follower in
// `king` mode, a tab left on the jam and forgotten — nobody reported anything
// and the clock kept counting. Measured in production: a room at 267.6 s of a
// 267.6 s track, index 9 of 16, `isPlaying: true`, nobody listening, the queue
// frozen since whenever that song started.
//
// `durationSeconds` was already on every queued track (see `toJamTrack` in
// MusicPlayerProvider) and never once read here. Reading it lets the server
// work out, from the state alone, which track a room is really on. That is the
// fix; the timer below only makes it happen in real time instead of the next
// time somebody looks.
// ---------------------------------------------------------------------------

/** A duration this file is willing to act on. Absent, zero or nonsense means
 *  the client stays the only authority on when that track ends. */
function trackDurationMs(track) {
  const seconds = track?.durationSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * Where the playhead really is, once the tracks it has run past are accounted
 * for. Pure: same `current`, `queue` and `now` in, same answer out, nothing
 * touched. Returns the corrected `current`, or null when there is nothing to
 * correct — which is the ordinary case and the one that must stay cheap.
 *
 * A long gap can cross several tracks at once (a laptop that slept, a room
 * left running overnight), so it walks rather than steps. Running off the end
 * of the queue freezes on the last track's final frame instead of wrapping or
 * running on: there is nothing after it to play, and a room that says it is
 * playing when it is not is exactly the bug being fixed.
 */
export function advanceToNow(current, queue, now) {
  if (!current.isPlaying) return null;
  let index = current.index;
  let positionMs = current.positionMs;
  let at = current.at;
  let moved = false;

  for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
    // Playing a track that is not there. Emptying a queue mid-song leaves
    // exactly this, and with no track to measure against, the clock below
    // would run forever — so the room that would next receive a track would
    // start it minutes in. There is nothing to play; say so.
    if (index < 0 || index >= queue.length) {
      return { index: Math.max(0, Math.min(index, queue.length - 1)), positionMs: 0, isPlaying: false, at: now };
    }
    const durationMs = trackDurationMs(queue[index]);
    // No trustworthy duration: leave this track alone, whatever else happened
    // before it. The client remains the source of truth for exactly this case.
    if (durationMs === null) break;
    const projected = positionMs + Math.max(0, now - at);
    if (projected < durationMs) break;
    if (index >= queue.length - 1) {
      return { index, positionMs: durationMs, isPlaying: false, at: now };
    }
    index += 1;
    // Carry the overshoot rather than starting the next track at zero, so a
    // room that crossed a boundary mid-gap lands where it would have been.
    positionMs = projected - durationMs;
    at = now;
    moved = true;
  }

  return moved ? { index, positionMs, isPlaying: true, at } : null;
}

// A room the server advanced by itself, and when. The client that was playing
// reports the same track ending a moment later, with a bare `next` that says
// nothing about which track it means — so without this, whichever arrived
// second skipped a song. Whoever gets there first wins and the loser is a
// no-op. In memory: it describes an instant, not the room.
//
// Only ever written after the advance has been PERSISTED AND BROADCAST. It was
// briefly written from the read path too, and that was a user-visible bug: the
// room was corrected in the reply and nowhere else, so opening the jam screen
// armed the swallow, and the Next button the user then pressed did nothing and
// still answered 200. A correction nobody was told about must not silently eat
// the next thing they ask for.
const autoAdvanced = new Map();

/** True if this `next` is the report of an end the server already handled.
 *  Consumes the record either way, so only ever one `next` is swallowed. */
function consumeAutoAdvance(jamId, index, now) {
  const record = autoAdvanced.get(jamId);
  if (record === undefined) return false;
  autoAdvanced.delete(jamId);
  return record.index === index && now - record.at <= CLIENT_NEXT_GRACE_MS;
}

/**
 * Apply `advanceToNow` to a jam in place. Returns what happened:
 * `'none'` — already correct; `'settled'` — corrected without landing on a new
 * playing track (the frozen end of a queue); `'skipped'` — the room moved onto
 * a different track, which is the case a client's `next` may be about to
 * report the end of.
 */
function normalizeProgress(jam, now) {
  const corrected = advanceToNow(jam.current, jam.queue, now);
  if (corrected === null) return 'none';
  const skipped = corrected.index !== jam.current.index && corrected.isPlaying;
  jam.current = corrected;
  return skipped ? 'skipped' : 'settled';
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

// ---------------------------------------------------------------------------
// Timers. Two per room at most, both in memory, both cancelled by the same
// `forgetRoom`, so a room that stops existing cannot leave one running.
// ---------------------------------------------------------------------------

/** jamId -> handle for the next queue advance. */
const advanceTimers = new Map();
/** jamId -> handle for the countdown that pauses an emptied room. */
const graceTimers = new Map();
/** Rooms this server paused because they emptied, and only those. Never
 *  written to jams.json: see `armEmptyGrace` for why that matters. */
const autoPaused = new Set();

function cancelAdvance(jamId) {
  const handle = advanceTimers.get(jamId);
  if (handle === undefined) return;
  advanceTimers.delete(jamId);
  clock.clearTimeout(handle);
}

function cancelEmptyGrace(jamId) {
  const handle = graceTimers.get(jamId);
  if (handle === undefined) return;
  graceTimers.delete(jamId);
  clock.clearTimeout(handle);
}

/** Everything this process was holding on behalf of a room that is gone. */
function forgetRoom(jamId) {
  cancelAdvance(jamId);
  cancelEmptyGrace(jamId);
  autoPaused.delete(jamId);
  autoAdvanced.delete(jamId);
}

/**
 * Wake up when the current track is due to end, so the queue moves in real
 * time rather than the next time somebody happens to read the room.
 *
 * A `setTimeout` for the exact remainder, not an interval: a room is idle
 * almost all of the time, and polling every second to discover that nothing
 * has changed would burn a wake-up per room per second forever. Always cancels
 * first, so re-arming on every write is how the timer stays honest about what
 * is playing instead of firing for a track the room has already left.
 */
function armAdvance(jam, now) {
  cancelAdvance(jam.id);
  if (!jam.current.isPlaying) return;
  const durationMs = trackDurationMs(jam.queue[jam.current.index]);
  if (durationMs === null) return; // the client owns this one
  const remaining = durationMs - (jam.current.positionMs + Math.max(0, now - jam.current.at));
  const handle = clock.setTimeout(() => {
    advanceTimers.delete(jam.id);
    return healRoom(jam.id);
  }, Math.max(0, remaining) + SERVER_ADVANCE_GRACE_MS);
  advanceTimers.set(jam.id, handle);
}

/**
 * Everything this process should be doing about a room, decided from the room
 * itself: when to advance it, and whether it is playing to nobody.
 *
 * The second half is what makes the two mechanisms agree. `armEmptyGrace` used
 * to be reachable only from a detach — and after a restart nobody has ever
 * attached, so no detach ever happens. Rooms left playing before the restart
 * would then be walked through their entire queue by the advance timer,
 * rewriting the shared file at every track boundary, for an audience of nobody.
 * Seeing such a room has to be enough to start the countdown.
 */
function reconsider(jam, now) {
  armAdvance(jam, now);
  if (jam.current.isPlaying && presenceOf(jam.id).size === 0) armEmptyGrace(jam.id);
}

/**
 * Push a room forward to the present and write it down.
 *
 * The `seq` bump is conditional, and today that condition cannot be false:
 * every path that changes what is playing goes through `armAdvance`, which
 * cancels and re-arms, so a timer that survives to fire always has work. It
 * stays because the alternative reads as "a tick is a write", and the first
 * change that leaves a stale timer behind would turn that into a room
 * renumbering itself on a schedule — with clients ordering by `seq`, that is a
 * broadcast storm rather than a wasted disk write.
 */
function healRoom(jamId) {
  return withLock(async () => {
    const jams = await load();
    const jam = jams.find((j) => j.id === jamId);
    if (!jam) return forgetRoom(jamId);
    // The only caller that records. This timer fires a second after a track's
    // nominal end, so it is the only correction in this file that happens
    // BECAUSE a track just ended — which is exactly when a client's own report
    // of that end is in flight. A read or an unrelated write can stumble on a
    // room that ran away hours ago, and assuming a report is coming for that
    // would mean somebody opening a stranded room and pressing Next had their
    // button press eaten. It did, before this distinction existed.
    await settle(jams, jam, { record: true });
  }).catch(() => undefined);
}

/**
 * Bring a room up to date, write the correction down if there was one, and
 * reconsider its timers. Shared by the timer and by every read.
 *
 * Reads persist too, and that is not incidental. Correcting only the reply
 * left the file disagreeing with what the user had just been shown, and the
 * command they sent next was then read against the stale file — the server
 * "discovered" the advance the reader had already been told about and treated
 * their Next button as a report of it. What a reader is told and what is on
 * disk have to be the same thing.
 */
async function settle(jams, jam, { record }) {
  const now = clock.now();
  const moved = normalizeProgress(jam, now);
  if (moved !== 'none') {
    jam.seq += 1;
    await persist(jams);
    broadcast(jam);
    if (record && moved === 'skipped') {
      autoAdvanced.set(jam.id, { index: jam.current.index, at: now });
    }
  }
  reconsider(jam, now);
  return moved;
}

// ---------------------------------------------------------------------------
// An empty room does not play
//
// The owner's words: "si no hay nadie en la jam que se pause la música hasta
// que alguien entre." Duration-driven advancing above keeps the queue honest;
// this keeps a room from playing to nobody at all.
// ---------------------------------------------------------------------------

/**
 * Start the countdown that pauses a room the last person just left.
 *
 * Nothing is written yet, and that is deliberate — see `EMPTY_ROOM_GRACE_MS`
 * for the reconnect and the navigation that both look exactly like leaving.
 */
function armEmptyGrace(jamId) {
  if (graceTimers.has(jamId)) return; // already counting down
  const handle = clock.setTimeout(() => {
    graceTimers.delete(jamId);
    // No presence check here on purpose. It would only ever agree with the one
    // `pauseBecauseEmpty` makes under the lock, an instant later and an
    // instant less accurately — and a guard that can never disagree with
    // another guard is a line no test can kill.
    return pauseBecauseEmpty(jamId);
  }, EMPTY_ROOM_GRACE_MS);
  graceTimers.set(jamId, handle);
}

/** Freeze the playhead of a room nobody is in. */
function pauseBecauseEmpty(jamId) {
  return mutate(jamId, (jam, present) => {
    if (present.size > 0) return { ok: false, reason: 'not_empty' };
    // Already stopped — by a person, by the end of the queue, by anything.
    // Leaving the flag untouched here is what lets a deliberate pause survive
    // the room emptying: nothing marked this pause as ours, so nothing will
    // undo it.
    if (!jam.current.isPlaying) return { ok: false, reason: 'not_playing' };
    const now = clock.now();
    jam.current.positionMs = projectedPositionMs(jam, now);
    jam.current.isPlaying = false;
    jam.current.at = now;
  })
    .then((out) => {
      // After the write, not inside it. Marking the room as ours to resume
      // before `persist` had run meant a disk error left the flag set on a
      // room that was still playing — and the second condition catches the
      // other half: somebody who walked in while that write was in flight has
      // already cleared the flag, and setting it again behind them would
      // start the music at them later for no reason.
      if (out.ok && presenceOf(jamId).size === 0) autoPaused.add(jamId);
    })
    .catch(() => {
      // The write failed and this countdown is one-shot — it has already
      // deleted itself. Without another, the room plays to nobody until the
      // next time somebody both arrives and leaves, which may be never.
      armEmptyGrace(jamId);
    });
}

/**
 * Undo our own pause for the first person through the door.
 *
 * The flag is cleared before anything else is decided, unconditionally. The
 * previous attempt cleared it only on the path that actually resumed, so a
 * room whose queue had been emptied kept the flag with people standing in it,
 * and the next arrival after that walked in to music starting by itself.
 * A room that is not empty is not paused-because-empty, whatever happens next.
 */
function resumeIfAutoPaused(jamId) {
  if (!autoPaused.delete(jamId)) return undefined;
  return mutate(jamId, (jam) => {
    if (jam.queue.length === 0) return { ok: false, reason: 'empty_queue' };
    if (jam.current.isPlaying) return { ok: false, reason: 'already_playing' };
    jam.current.isPlaying = true;
    jam.current.at = clock.now();
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/** Drop one held response. Returns whether it was still registered, which is
 *  how `detach` tells "the socket closed" from "we already closed it". */
function removeStream(jamId, userId, res) {
  const byUser = streams.get(jamId);
  if (!byUser) return false;
  const responses = byUser.get(userId);
  if (!responses || !responses.delete(res)) return false;
  if (responses.size === 0) byUser.delete(userId);
  if (byUser.size === 0) streams.delete(jamId);
  return true;
}

/** Presence just changed: tell the room, and start the countdown if the room
 *  turns out to be nobody. */
function onPresenceChanged(jamId) {
  if (presenceOf(jamId).size === 0) {
    armEmptyGrace(jamId);
    return; // nobody left to broadcast to; the disk read would be for nothing
  }
  void getJam(jamId).then((jam) => {
    if (jam) broadcast(jam);
  });
}

/**
 * Hang up on someone who is no longer a member.
 *
 * `leaveJam` and `removeMember` used to edit the member list and stop there.
 * The socket stayed open, so the server kept pushing the room's every change
 * to somebody it had just thrown out, and — because presence IS the socket —
 * their ghost kept the room from ever counting as empty.
 */
export function closeUserStreams(jamId, userId) {
  const byUser = streams.get(jamId);
  const responses = byUser?.get(userId);
  if (!responses) return;
  const held = [...responses];
  responses.clear();
  byUser.delete(userId);
  if (byUser.size === 0) streams.delete(jamId);
  for (const res of held) {
    try {
      res.end();
    } catch {
      // A socket that is already gone is the outcome we wanted anyway, and one
      // failure must not leave the rest of this person's tabs connected.
    }
  }
  onPresenceChanged(jamId);
}

/**
 * Attach a live SSE response to a jam. Returns a detach function.
 *
 * Attaching and detaching both re-broadcast, because either can change who the
 * leader is — that is the whole point of deriving it from presence.
 */
export function attach(jamId, userId, res) {
  let byUser = streams.get(jamId);
  const wasEmpty = !byUser || byUser.size === 0;
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

  if (wasEmpty) {
    // Inside the grace period: the room never stopped, so there is nothing to
    // undo. This is the reconnect and the screen change, and it must cost
    // nothing — no write, no broadcast, no audible seam. Cancelling rather
    // than letting the countdown expire harmlessly also means the NEXT time
    // this room empties it gets a full grace period rather than the tail of
    // this one, and leaves no timer behind for a room somebody is sitting in.
    cancelEmptyGrace(jamId);
    void resumeIfAutoPaused(jamId);
  }

  let detached = false;
  return function detach() {
    if (detached) return; // 'close' can fire more than once
    detached = true;
    // False when `closeUserStreams` got here first, which already did all of
    // this; doing it twice would arm a second countdown on the same room.
    if (!removeStream(jamId, userId, res)) return;
    onPresenceChanged(jamId);
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

/**
 * Reads heal too, so any look at a room cures one that already ran away.
 *
 * That is not belt and braces: there are rooms on disk right now sitting past
 * the end of a track, and after a restart nothing has scheduled a timer for
 * any of them. The first read is what corrects them — no migration, the first
 * person to open the app is the cure.
 */
export function getJam(jamId) {
  return withLock(async () => {
    const jams = await load();
    const jam = jams.find((j) => j.id === jamId) ?? null;
    if (jam) await settle(jams, jam, { record: false });
    return jam;
  });
}

/** Every jam this user belongs to, accepted or still pending. Pending ones are
 *  how the invitation reaches them: there is no separate inbox to keep in
 *  step with the membership list. */
export function listJamsForUser(userId) {
  return withLock(async () => {
    const jams = await load();
    const mine = jams.filter((j) => j.members.some((m) => m.userId === userId));
    // The whole list is corrected before anything is written, so a user with
    // five stranded rooms costs one rewrite of the shared file rather than
    // five. This is the read that runs when somebody opens the app, so it is
    // usually the first one to touch a room that ran away.
    const now = clock.now();
    const corrected = mine.filter((jam) => normalizeProgress(jam, now) !== 'none');
    for (const jam of corrected) jam.seq += 1;
    if (corrected.length > 0) await persist(jams);
    for (const jam of corrected) broadcast(jam);
    for (const jam of mine) reconsider(jam, now);
    return mine.map((j) => ({
      ...snapshot(j),
      myRole: j.members.find((m) => m.userId === userId),
    }));
  });
}

// ---------------------------------------------------------------------------
// Writes. Every one returns { ok, reason?, jam? } rather than throwing, so the
// route layer maps reasons to status codes in one place.
// ---------------------------------------------------------------------------

/** What a command returns when the room is already in the state it asked for.
 *  Answered as success, because from the caller's side it is — but without a
 *  `seq` bump, a rewrite of the file every other room shares, or a broadcast
 *  of a snapshot identical to the one everybody already has. */
const UNCHANGED = Symbol('unchanged');

function mutate(jamId, fn) {
  return withLock(async () => {
    const jams = await load();
    const jam = jams.find((j) => j.id === jamId);
    if (!jam) {
      forgetRoom(jamId);
      return { ok: false, reason: 'not_found' };
    }
    const now = clock.now();
    // Before the command, not after: `next` has to see the index the room is
    // really on, or a client reporting the end of track 9 while the room has
    // already reached 10 would move it to 11.
    const ctx = { now, skipped: normalizeProgress(jam, now) === 'skipped' };
    const outcome = fn(jam, presenceOf(jamId), ctx);
    // Nothing is persisted and nothing is announced, so nothing is recorded
    // either — including the correction above, which is discarded with the
    // rest. A command the room refused must leave no trace on the next one.
    if (outcome && outcome.ok === false) return outcome;
    if (outcome === UNCHANGED) return { ok: true, jam };
    jam.seq += 1;
    await persist(jams);
    broadcast(jam);
    reconsider(jam, now);
    return { ok: true, jam };
  });
}


export function createJam({ ownerId, ownerName, name, mode }) {
  return withLock(async () => {
    const jams = await load();
    const now = clock.now();
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
    const now = clock.now();
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
    member.acceptedAt = clock.now();
  });
}

/** Leaving is permanent and deliberate, unlike closing the stream. The owner
 *  cannot leave their own room -- they transfer it or it stays theirs. */
export function leaveJam(jamId, userId) {
  return mutate(jamId, (jam) => {
    if (isOwner(jam, userId)) return { ok: false, reason: 'owner_cannot_leave' };
    if (!jam.members.some((m) => m.userId === userId)) return { ok: false, reason: 'not_member' };
    jam.members = jam.members.filter((m) => m.userId !== userId);
  }).then(hangUpOn(jamId, userId));
}

/** Close the leaver's stream once, and only once, the removal has actually
 *  landed. `mutate` has already broadcast by then, so their last event is the
 *  room without them in it — which is how their client learns to stop. */
function hangUpOn(jamId, userId) {
  return (outcome) => {
    if (outcome.ok) closeUserStreams(jamId, userId);
    return outcome;
  };
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
  }).then(hangUpOn(jamId, targetUserId));
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
      jam.current = { index: 0, positionMs: 0, isPlaying: true, at: clock.now() };
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
      jam.current.at = clock.now();
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
  return mutate(jamId, (jam, present, ctx) => {
    if (!canControlTransport(jam, present, userId)) return { ok: false, reason: 'forbidden' };
    const now = ctx.now;
    const last = jam.queue.length - 1;
    // The client sends this same bare `next` whether a track ended or a person
    // pressed the button, so the two have to be told apart by timing. If the
    // room has already moved off the track this caller was on — a moment ago
    // by its own timer, or just now at the top of this very call — treat it as
    // the report it is and answer with the state it was asking for. Racing the
    // client is unavoidable, since both are allowed to notice the end of a
    // song; skipping one because both noticed is not.
    if (command.type === 'next') {
      // This call is the one that noticed. Write the correction down and stop
      // there — that IS the advance the client was asking for, and doing it
      // again on top would be the skipped song.
      if (ctx.skipped) return undefined;
      // The server's own timer got there first, and already persisted and
      // announced it. There is genuinely nothing left to do.
      if (consumeAutoAdvance(jamId, jam.current.index, now)) return UNCHANGED;
    }
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
    // Nothing clears `autoPaused` here on purpose. Transport needs presence,
    // presence needs an attach, and every attach that finds an empty room
    // clears the flag before anything else — so by the time any command can
    // reach this line the flag is already gone. A `delete` here would be a
    // line no test could ever kill.
  });
}

/** Where playback is now, given when it was last set. Exported because both
 *  the pause path and any follower need the same arithmetic. */
export function projectedPositionMs(jam, now = clock.now()) {
  if (!jam.current.isPlaying) return jam.current.positionMs;
  return jam.current.positionMs + Math.max(0, now - jam.current.at);
}
