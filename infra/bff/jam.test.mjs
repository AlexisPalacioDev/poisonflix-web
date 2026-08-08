// First tests the BFF has ever had. Node's built-in runner, because this
// server has zero runtime dependencies and adding one to test it would be a
// strange thing to do to it.
//
//   node --test infra/bff/jam.test.mjs
//
// JAM_FILE is redirected to a temp file BEFORE importing the module, since it
// reads the env var at import time.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
let jamStore;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jam-test-'));
  process.env.JAM_FILE = join(dir, 'jams.json');
  jamStore = await import('./jam.mjs');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test starts from an empty store; the module reads the file every
  // time, so deleting it is enough.
  await rm(process.env.JAM_FILE, { force: true });
});

function room(over = {}) {
  return {
    id: 'j1',
    name: 'Ruta',
    mode: 'king',
    ownerId: 'king',
    createdAt: 0,
    members: [
      { userId: 'king', name: 'King', role: 'owner', invitedAt: 0, acceptedAt: 1 },
      { userId: 'ctrl', name: 'Ctrl', role: 'controller', invitedAt: 0, acceptedAt: 2 },
      { userId: 'ears', name: 'Ears', role: 'listener', invitedAt: 0, acceptedAt: 3 },
      { userId: 'pending', name: 'Pending', role: 'listener', invitedAt: 0, acceptedAt: null },
    ],
    queue: [],
    current: { index: 0, positionMs: 0, isPlaying: false, at: 0 },
    seq: 0,
    ...over,
  };
}

describe('effectiveLeader', () => {
  test('the owner outranks everyone present', () => {
    assert.equal(jamStore.effectiveLeader(room(), new Set(['king', 'ctrl'])), 'king');
  });

  test('a controller takes over when the owner is away', () => {
    assert.equal(jamStore.effectiveLeader(room(), new Set(['ctrl', 'ears'])), 'ctrl');
  });

  test('a listener runs the room when nobody better is there', () => {
    assert.equal(jamStore.effectiveLeader(room(), new Set(['ears'])), 'ears');
  });

  test('the owner reclaims the room simply by reappearing', () => {
    const jam = room();
    assert.equal(jamStore.effectiveLeader(jam, new Set(['ctrl'])), 'ctrl');
    assert.equal(jamStore.effectiveLeader(jam, new Set(['ctrl', 'king'])), 'king');
  });

  test('an invitation that was never accepted does not make anyone a leader', () => {
    assert.equal(jamStore.effectiveLeader(room(), new Set(['pending'])), null);
  });

  test('an empty room has no leader, which is not an error', () => {
    assert.equal(jamStore.effectiveLeader(room(), new Set()), null);
  });
});

describe('permissions', () => {
  test('a granted controller may drive even with the owner present', () => {
    assert.equal(jamStore.canControlTransport(room(), new Set(['king', 'ctrl']), 'ctrl'), true);
  });

  test('a listener may not drive', () => {
    assert.equal(jamStore.canControlTransport(room(), new Set(['king', 'ears']), 'ears'), false);
  });

  test('even the owner may not drive a room they are not attached to', () => {
    assert.equal(jamStore.canControlTransport(room(), new Set(['ctrl']), 'king'), false);
  });

  test('any accepted member may queue, attached or not', () => {
    assert.equal(jamStore.canQueue(room(), 'ears'), true);
  });

  test('someone who never accepted may not queue', () => {
    assert.equal(jamStore.canQueue(room(), 'pending'), false);
  });
});

describe('store', () => {
  test('a new jam seats its creator immediately', async () => {
    const { jam } = await jamStore.createJam({
      ownerId: '1',
      ownerName: 'perroenvenenado',
      name: 'Moto',
      mode: 'everyone',
    });
    assert.equal(jam.ownerId, '1');
    assert.equal(jam.mode, 'everyone');
    assert.equal(jam.members.length, 1);
    // Not null: making the creator accept their own invitation would be theatre.
    assert.notEqual(jam.members[0].acceptedAt, null);
  });

  test('only the owner may invite', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    const denied = await jamStore.inviteMembers(jam.id, '999', [{ userId: '2', name: 'B' }]);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'forbidden');
  });

  test('an invitee is not in the room until they accept', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);

    const invited = await jamStore.getJam(jam.id);
    assert.equal(invited.members.find((m) => m.userId === '2').acceptedAt, null);
    assert.equal(jamStore.canQueue(invited, '2'), false);

    await jamStore.respondToInvite(jam.id, '2', true);
    const joined = await jamStore.getJam(jam.id);
    assert.equal(jamStore.canQueue(joined, '2'), true);
  });

  test('declining removes the invitation rather than leaving it hanging', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', false);
    const after = await jamStore.getJam(jam.id);
    assert.equal(after.members.some((m) => m.userId === '2'), false);
  });

  test('the owner cannot leave their own room', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    const out = await jamStore.leaveJam(jam.id, '1');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'owner_cannot_leave');
  });

  test('transferring the crown leaves the former owner with control', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);
    await jamStore.transferOwnership(jam.id, '1', '2');

    const after = await jamStore.getJam(jam.id);
    assert.equal(after.ownerId, '2');
    assert.equal(after.members.find((m) => m.userId === '2').role, 'owner');
    // Dropping the previous owner to listener would read as a bug: they were
    // running the room a second ago.
    assert.equal(after.members.find((m) => m.userId === '1').role, 'controller');
  });

  test('the owner can remove a member who will not behave', async () => {
    // Before this existed, `leaveJam` was the only way out of a room and only
    // the member themself could call it — so a guest clearing the queue over
    // and over could not be removed by anyone.
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);

    const out = await jamStore.removeMember(jam.id, '1', '2');
    assert.equal(out.ok, true);
    const after = await jamStore.getJam(jam.id);
    assert.equal(after.members.some((m) => m.userId === '2'), false);
  });

  test('a member cannot remove anyone, and nobody can remove the owner', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);

    assert.equal((await jamStore.removeMember(jam.id, '2', '1')).reason, 'forbidden');
    assert.equal((await jamStore.removeMember(jam.id, '1', '1')).reason, 'cannot_remove_owner');
  });

  test('every accepted invitation survives a reload from disk', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);

    // getJam reads the file every call, so this is a genuine round trip.
    const reloaded = await jamStore.getJam(jam.id);
    assert.equal(reloaded.members.length, 2);
    assert.equal(jamStore.canQueue(reloaded, '2'), true);
  });
});

describe('queue and transport', () => {
  // Presence is the SSE connection, so driving a room in a test means opening
  // one. Faking it at this seam rather than relaxing the rule keeps the test
  // honest: "you cannot pause a room you left" is the behaviour, and a test
  // that needed it turned off would be testing something else.
  const detachers = [];
  function enterRoom(jamId, userId) {
    detachers.push(jamStore.attach(jamId, userId, { write() {} }));
  }
  after(() => {
    for (const detach of detachers) detach();
  });

  async function seeded() {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [
      { itemId: 'a', title: 'A' },
      { itemId: 'b', title: 'B' },
      { itemId: 'c', title: 'C' },
    ]);
    enterRoom(jam.id, '1');
    return jam.id;
  }

  test('a command from someone who is not in the room is refused', async () => {
    const id = await seeded();
    const out = await jamStore.transport(id, 'stranger', { type: 'play' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'forbidden');
  });

  test('a non-member cannot queue', async () => {
    const id = await seeded();
    const out = await jamStore.addTracks(id, 'stranger', [{ itemId: 'x', title: 'X' }]);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'forbidden');
  });

  test('a queued track records who put it there', async () => {
    const id = await seeded();
    const jam = await jamStore.getJam(id);
    assert.equal(jam.queue[0].addedBy, '1');
  });

  test('removing a track before the current one keeps the same song playing', async () => {
    const id = await seeded();
    await jamStore.transport(id, '1', { type: 'jump', index: 2 }); // playing 'c'
    await jamStore.removeTrack(id, '1', 0); // drop 'a'

    const jam = await jamStore.getJam(id);
    // Without the adjustment the index would still say 2 and the room would
    // have silently skipped forward.
    assert.equal(jam.current.index, 1);
    assert.equal(jam.queue[jam.current.index].itemId, 'c');
  });

  test('pause freezes where playback actually is, not where it was last set', async () => {
    const id = await seeded();
    await jamStore.transport(id, '1', { type: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await jamStore.transport(id, '1', { type: 'pause' });

    const jam = await jamStore.getJam(id);
    assert.equal(jam.current.isPlaying, false);
    // Naively storing the last command's position would rewind to 0 on every
    // pause, so the room would restart the song each time.
    assert.ok(jam.current.positionMs >= 30, `expected elapsed time, got ${jam.current.positionMs}`);
  });

  test('next refuses to run off the end of the queue', async () => {
    const id = await seeded();
    await jamStore.transport(id, '1', { type: 'jump', index: 2 });
    const out = await jamStore.transport(id, '1', { type: 'next' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'end_of_queue');
  });

  test('every applied command advances the sequence the clients order by', async () => {
    const id = await seeded();
    const before = (await jamStore.getJam(id)).seq;
    await jamStore.transport(id, '1', { type: 'play' });
    const after = (await jamStore.getJam(id)).seq;
    assert.ok(after > before, 'seq must advance so two controllers cannot disagree');
  });

  test('an oversized id is capped instead of stored whole', async () => {
    // Found by adversarial review, reproduced against the real module: every
    // other string field was capped and these two were not, so one member
    // could push a megabyte-long id. That matters more than it looks —
    // `persist` rewrites the single shared jams.json on every mutation of ANY
    // room, and `broadcast` re-sends the whole snapshot to everyone present.
    const id = await seeded();
    await jamStore.addTracks(id, '1', [{ itemId: 'x'.repeat(900_000), title: 'T', videoId: 'y'.repeat(900_000) }]);

    const jam = await jamStore.getJam(id);
    const stored = jam.queue.at(-1);
    assert.ok(stored.itemId.length <= 200, `itemId stored at ${stored.itemId.length} chars`);
    assert.ok(stored.videoId.length <= 200, `videoId stored at ${stored.videoId.length} chars`);
  });

  test('a queue that would outgrow the byte ceiling is refused', async () => {
    // A count limit is not a size limit: 500 tracks of capped-but-large
    // strings still add up, and they land in a file every other room shares.
    const id = await seeded();
    const fat = Array.from({ length: 400 }, (_, i) => ({
      itemId: `id-${i}`.padEnd(200, 'x'),
      title: 'T'.repeat(200),
      artist: 'A'.repeat(200),
      coverUrl: 'c'.repeat(500),
      streamUrl: 's'.repeat(500),
    }));
    const out = await jamStore.addTracks(id, '1', fat);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'queue_full');
  });

  test('a listener cannot delete a track someone else queued', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);
    await jamStore.addTracks(jam.id, '1', [{ itemId: 'a', title: 'A' }]);
    // The owner has to be in the room too. With only '2' attached, '2' IS the
    // acting leader — leadership follows presence — and a leader is entitled
    // to clear anyone's track. Testing the listener rule means arranging for
    // them not to be in charge.
    enterRoom(jam.id, '1');
    enterRoom(jam.id, '2');

    const out = await jamStore.removeTrack(jam.id, '2', 0);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not_yours');
  });

  test('but may delete the one they queued themselves', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);
    await jamStore.addTracks(jam.id, '2', [{ itemId: 'mine', title: 'Mine' }]);

    const out = await jamStore.removeTrack(jam.id, '2', 0);
    assert.equal(out.ok, true);
  });

  test('a rejected command does not advance the sequence', async () => {
    const id = await seeded();
    const before = (await jamStore.getJam(id)).seq;
    await jamStore.transport(id, 'stranger', { type: 'play' });
    const after = (await jamStore.getJam(id)).seq;
    assert.equal(after, before);
  });
});


// ---------------------------------------------------------------------------
// Driving time instead of racing it.
//
// Everything below turns on timers, and the interesting assertions are
// negatives: nothing paused yet, nothing resumed, the queue did NOT advance
// twice. A negative asserted after a fixed `sleep` is a bet on how fast this
// machine is — it passes on a loaded CI box for the same reason it passes on a
// correct implementation, which makes it worth nothing. So the module's clock
// is taken over and stepped by hand.
//
// The other half is ordering. `attach` and `detach` hand their writes to
// floating promises, but every one of those goes through the same serialising
// lock as `getJam` — so awaiting a read is a genuine guarantee that any write
// already queued has landed. That is what `settled()` is for.
// ---------------------------------------------------------------------------

function takeOverTheClock(mod = jamStore) {
  const original = {
    now: mod.clock.now,
    setTimeout: mod.clock.setTimeout,
    clearTimeout: mod.clock.clearTimeout,
  };
  const pending = new Map();
  let nextHandle = 0;
  let now = 1_700_000_000_000;

  mod.clock.now = () => now;
  mod.clock.setTimeout = (fn, ms) => {
    const handle = (nextHandle += 1);
    pending.set(handle, { fn, dueAt: now + ms });
    return handle;
  };
  mod.clock.clearTimeout = (handle) => {
    pending.delete(handle);
  };

  return {
    get now() {
      return now;
    },
    get pending() {
      return pending.size;
    },
    advance(ms) {
      now += ms;
    },
    /** Run every timer that has come due, awaiting whatever it starts. */
    async fire() {
      let fired = 0;
      for (const [handle, timer] of [...pending]) {
        if (timer.dueAt > now) continue;
        pending.delete(handle);
        await timer.fn();
        fired += 1;
      }
      return fired;
    },
    /** Timers armed by an earlier test are not this test's business, and
     *  counting them would make `pending` mean nothing. */
    reset() {
      pending.clear();
    },
    restore() {
      Object.assign(mod.clock, original);
      pending.clear();
    },
  };
}

/** A held SSE response is only ever written to and ended. */
function socket() {
  const sent = [];
  let ended = false;
  return {
    sent,
    get ended() {
      return ended;
    },
    write(chunk) {
      if (ended) throw new Error('wrote to a response that was already ended');
      sent.push(chunk);
    },
    end() {
      ended = true;
    },
  };
}

/** Reading through the lock: any write already queued has finished by the time
 *  this resolves. The honest way to assert that nothing happened. */
const settled = (id) => jamStore.getJam(id);

/** Module state (streams, timers, flags) is keyed by jam id and never reset
 *  between tests, so a hand-written fixture must not reuse an id the way the
 *  UUIDs from `createJam` never can. */
let fixtureCount = 0;
const freshId = (prefix) => `${prefix}-${(fixtureCount += 1)}`;

const readFileRoom = async (id) => {
  const raw = JSON.parse(await readFile(process.env.JAM_FILE, 'utf8'));
  return raw.jams.find((j) => j.id === id) ?? null;
};

describe('the server works out which track a room is really on', () => {
  const playing = (over = {}) => ({ index: 0, positionMs: 0, isPlaying: true, at: 1000, ...over });
  const song = (durationSeconds) => ({ itemId: 'x', title: 'X', durationSeconds });

  test('a track still running is left exactly alone', () => {
    const queue = [song(200)];
    assert.equal(jamStore.advanceToNow(playing(), queue, 1000 + 199_999), null);
  });

  test('a paused room is never advanced, however long it has sat there', () => {
    // Its clock is not running, so it cannot have run away. And the frozen
    // final frame of a finished queue lives in exactly this shape — advancing
    // it would make that state unstable.
    const current = { index: 0, positionMs: 200_000, isPlaying: false, at: 1000 };
    assert.equal(jamStore.advanceToNow(current, [song(200)], 1000 + 999_999_999), null);
  });

  test('a track with no duration is the client\'s business, not this file\'s', () => {
    // Older queued tracks have no `durationSeconds` at all, and a stream whose
    // length nobody knows must not be guessed at.
    assert.equal(jamStore.advanceToNow(playing(), [song(null), song(10)], 1000 + 500_000), null);
    assert.equal(jamStore.advanceToNow(playing(), [{ itemId: 'x', title: 'X' }], 1000 + 5e6), null);
    assert.equal(jamStore.advanceToNow(playing(), [song(0)], 1000 + 5e6), null);
    assert.equal(jamStore.advanceToNow(playing(), [song(-30)], 1000 + 5e6), null);
  });

  test('a track that reaches exactly its own length is over', () => {
    // The boundary is where the production room was found sitting: at the
    // duration, not past it. Off by one here and the room hangs on the last
    // millisecond of every song until something else nudges it.
    const out = jamStore.advanceToNow(playing(), [song(200), song(200)], 1000 + 200_000);
    assert.equal(out.index, 1);
    assert.equal(out.positionMs, 0);
  });

  test('overrunning a track moves to the next one carrying the overshoot', () => {
    const out = jamStore.advanceToNow(playing(), [song(200), song(200)], 1000 + 200_400);
    // Starting the next track at zero would rewind the room by however long
    // nobody was looking.
    assert.deepEqual(out, { index: 1, positionMs: 400, isPlaying: true, at: 1000 + 200_400 });
  });

  test('a long gap crosses several tracks in one go', () => {
    // A laptop that slept, or a room left running overnight. Stepping once per
    // read would need one read per song to catch up.
    const queue = [song(100), song(100), song(100), song(100)];
    const out = jamStore.advanceToNow(playing(), queue, 1000 + 250_000);
    assert.equal(out.index, 2);
    assert.equal(out.positionMs, 50_000);
    assert.equal(out.isPlaying, true);
  });

  test('the walk stops at the first track whose length is unknown', () => {
    const queue = [song(100), song(null), song(100)];
    const out = jamStore.advanceToNow(playing(), queue, 1000 + 250_000);
    assert.equal(out.index, 1);
    assert.equal(out.isPlaying, true);
  });

  test('running off the end freezes on the last frame instead of claiming to play', () => {
    const out = jamStore.advanceToNow(playing(), [song(100), song(100)], 1000 + 999_999);
    assert.deepEqual(out, { index: 1, positionMs: 100_000, isPlaying: false, at: 1000 + 999_999 });
  });

  test('a clock that steps backwards cannot un-strand a room', () => {
    // NTP can step the wall clock back. The position already written down is a
    // fact; a negative elapsed time must not be allowed to subtract from it
    // and make a stranded room look healthy again.
    const stranded = { index: 0, positionMs: 267_600, isPlaying: true, at: 5_000 };
    const out = jamStore.advanceToNow(stranded, [song(267), song(267)], 4_000);
    assert.equal(out.index, 1);
    assert.equal(out.positionMs, 600);
  });

  test('a room playing a track that is not there stops instead of counting forever', () => {
    // Emptying a queue mid-song leaves exactly this shape. Left running, the
    // clock keeps going with nothing to measure against, and whatever track
    // gets queued next starts however many minutes in.
    const out = jamStore.advanceToNow({ index: 0, positionMs: 0, isPlaying: true, at: 1_000 }, [], 61_000);
    assert.deepEqual(out, { index: 0, positionMs: 0, isPlaying: false, at: 61_000 });
  });

  test('an index past the end of the queue is not a track either', () => {
    const out = jamStore.advanceToNow({ index: 5, positionMs: 0, isPlaying: true, at: 1_000 }, [song(10), song(10)], 1_000);
    assert.equal(out.isPlaying, false);
    assert.equal(out.index, 1);
  });

  test('the frozen end of a queue is a fixed point, not a state that keeps moving', () => {
    const frozen = { index: 1, positionMs: 100_000, isPlaying: false, at: 5000 };
    assert.equal(jamStore.advanceToNow(frozen, [song(100), song(100)], 9e9), null);
  });
});

describe('a room that ran away heals itself', () => {
  let ticker;
  before(() => {
    ticker = takeOverTheClock();
  });
  beforeEach(() => ticker.reset());
  after(() => ticker.restore());

  /** Sixteen tracks of 267 s, playing, index 9, and 267.6 s into it: the exact
   *  state a real room was found in, with the queue frozen since that song
   *  started and nobody in the room to report the end of it. */
  async function theRoomFoundInProduction() {
    const jam = {
      id: freshId('stuck'),
      name: 'Ruta',
      mode: 'everyone',
      ownerId: '1',
      createdAt: 0,
      members: [{ userId: '1', name: 'K', role: 'owner', invitedAt: 0, acceptedAt: 1 }],
      queue: Array.from({ length: 16 }, (_, i) => ({
        itemId: `t${i}`,
        title: `Track ${i}`,
        artist: null,
        coverUrl: null,
        videoId: null,
        durationSeconds: 267,
        streamUrl: null,
        addedBy: '1',
      })),
      current: { index: 9, positionMs: 267_600, isPlaying: true, at: ticker.now },
      seq: 42,
    };
    await writeFile(process.env.JAM_FILE, JSON.stringify({ jams: [jam] }, null, 2), 'utf8');
    return jam.id;
  }

  test('merely reading the room already gives the right answer', async () => {
    // This is what makes the deploy fix the rooms that are already broken:
    // there is no migration, the first person to open the app is the cure.
    const id = await theRoomFoundInProduction();
    const jam = await jamStore.getJam(id);
    assert.equal(jam.current.index, 10);
    assert.equal(jam.current.positionMs, 600);
    assert.equal(jam.current.isPlaying, true);
  });

  test('and the correction is on disk before the reader is answered', async () => {
    // A read that fixed only its own reply left the file still saying index 9,
    // and the very next command was then read against that stale file: the
    // server "discovered" the advance the reader had just been shown and
    // treated their Next button as a report of it. The button did nothing and
    // still answered 200. What a reader is told and what is on disk are the
    // same thing.
    const id = await theRoomFoundInProduction();
    const answered = await jamStore.getJam(id);

    const onDisk = await readFileRoom(id);
    assert.equal(onDisk.current.index, answered.current.index);
    assert.equal(onDisk.current.positionMs, answered.current.positionMs);
    assert.ok(onDisk.seq > 42, 'clients order by seq, so a real change has to bump it');
  });

  test('pressing Next on a room that had run away moves one track, not none', async () => {
    // The whole point of the paragraph above, from the user's side.
    const id = await theRoomFoundInProduction();
    jamStore.attach(id, '1', socket());
    const shown = (await jamStore.currentSnapshot(id)).jam.current.index;
    assert.equal(shown, 10);

    await jamStore.transport(id, '1', { type: 'next' });
    assert.equal((await settled(id)).current.index, 11, 'the Next button did nothing');
  });

  test('a read that finds nothing wrong does not rewrite the file', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [{ itemId: 'a', title: 'A', durationSeconds: 600 }]);
    jamStore.attach(jam.id, '1', socket());
    await jamStore.transport(jam.id, '1', { type: 'play' });
    const before = (await readFileRoom(jam.id)).seq;

    await jamStore.getJam(jam.id);
    await jamStore.listJamsForUser('1');

    assert.equal((await readFileRoom(jam.id)).seq, before, 'reading a healthy room rewrote it');
  });

  test('the room list heals the rooms it hands back, not just getJam', async () => {
    // This is the read that runs when somebody opens the app, so it is the one
    // most likely to be the first to touch a room that ran away days ago.
    const id = await theRoomFoundInProduction();
    const [entry] = await jamStore.listJamsForUser('1');
    assert.equal(entry.jam.id, id);
    assert.equal(entry.jam.current.index, 10);
  });

  test('a room that vanished from the file takes its timer with it', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [{ itemId: 'a', title: 'A', durationSeconds: 600 }]);
    jamStore.attach(jam.id, '1', socket());
    await jamStore.transport(jam.id, '1', { type: 'play' });
    assert.ok(ticker.pending >= 1, 'expected a timer for a ten-minute track');

    await writeFile(process.env.JAM_FILE, JSON.stringify({ jams: [] }, null, 2), 'utf8');
    const out = await jamStore.transport(jam.id, '1', { type: 'pause' });

    assert.equal(out.reason, 'not_found');
    assert.equal(ticker.pending, 0, 'a timer is still waiting on a room that no longer exists');
  });

  test('the timer moves the queue on time without anybody reading the room', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [
      { itemId: 'a', title: 'A', durationSeconds: 10 },
      { itemId: 'b', title: 'B', durationSeconds: 10 },
    ]);
    jamStore.attach(jam.id, '1', socket());
    await jamStore.transport(jam.id, '1', { type: 'play' });

    ticker.advance(9_000);
    assert.equal(await ticker.fire(), 0, 'nothing is due yet');
    assert.equal((await settled(jam.id)).current.index, 0);

    ticker.advance(2_100); // past the 10 s track and the one-second backstop
    await ticker.fire();
    assert.equal((await readFileRoom(jam.id)).current.index, 1);
  });

  test('a command lands on the track the room is really on, not the stale one', async () => {
    // Nothing has armed a timer for a room that ran away before a restart, so
    // the first thing to touch it may well be a command. Applying that command
    // to the stale index writes the runaway state back down as if it were
    // true.
    const farGone = freshId('far-gone');
    const jam = {
      id: farGone,
      name: 'Ruta',
      mode: 'everyone',
      ownerId: '1',
      createdAt: 0,
      members: [{ userId: '1', name: 'K', role: 'owner', invitedAt: 0, acceptedAt: 1 }],
      queue: Array.from({ length: 5 }, (_, i) => ({
        itemId: `t${i}`,
        title: `T${i}`,
        durationSeconds: 100,
        addedBy: '1',
      })),
      current: { index: 0, positionMs: 250_000, isPlaying: true, at: ticker.now },
      seq: 3,
    };
    await writeFile(process.env.JAM_FILE, JSON.stringify({ jams: [jam] }, null, 2), 'utf8');
    jamStore.attach(farGone, '1', socket());

    await jamStore.transport(farGone, '1', { type: 'pause' });

    const onDisk = await readFileRoom(farGone);
    assert.equal(onDisk.current.index, 2, 'pause froze the room on a track it left long ago');
    assert.equal(onDisk.current.positionMs, 50_000);
  });

  test('the last track ending stops the room instead of counting past it', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [{ itemId: 'a', title: 'A', durationSeconds: 10 }]);
    jamStore.attach(jam.id, '1', socket());
    await jamStore.transport(jam.id, '1', { type: 'play' });

    ticker.advance(60_000);
    await ticker.fire();

    const done = await settled(jam.id);
    assert.equal(done.current.isPlaying, false);
    assert.equal(done.current.positionMs, 10_000);
    // And nothing is left ticking for a room that has stopped.
    assert.equal(ticker.pending, 0, 'a stopped room must not hold a timer');
  });

  test('a room whose queue is emptied stops, and stops holding a timer', async () => {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [{ itemId: 'a', title: 'A', durationSeconds: 10 }]);
    jamStore.attach(jam.id, '1', socket());
    await jamStore.transport(jam.id, '1', { type: 'play' });
    assert.ok(ticker.pending >= 1);

    await jamStore.removeTrack(jam.id, '1', 0);

    assert.equal(ticker.pending, 0, 'an orphaned timer for a track that is gone');
    // And it must not be left claiming to play a track that is not there: the
    // clock would run on, and the next track queued would start minutes in.
    assert.equal((await settled(jam.id)).current.isPlaying, false);
  });

  test('a room left playing before a restart is stopped, not walked through its queue', async () => {
    // After a restart nobody has ever attached, so no detach will ever start
    // the empty-room countdown. Seeing the room has to be enough — otherwise
    // the backstop cheerfully walks it through all sixteen tracks in real
    // time, rewriting the shared file at every boundary, for nobody.
    const id = await theRoomFoundInProduction();
    await jamStore.getJam(id);

    ticker.advance(11_000);
    await ticker.fire();

    assert.equal((await settled(id)).current.isPlaying, false, 'still playing to an empty room');
  });

  test('reading an empty room over and over leaves one countdown, not one each', async () => {
    const id = await theRoomFoundInProduction();
    await jamStore.getJam(id);
    for (let i = 0; i < 5; i += 1) {
      ticker.advance(2_000);
      await jamStore.getJam(id);
    }
    // One backstop for the current track, one countdown for the empty room.
    assert.equal(ticker.pending, 2, 'every read left another countdown behind');
  });
});

describe('the client and the server both notice the end of a song', () => {
  let ticker;
  before(() => {
    ticker = takeOverTheClock();
  });
  beforeEach(() => ticker.reset());
  after(() => ticker.restore());

  async function threeTenSecondTracks() {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'king' });
    await jamStore.addTracks(jam.id, '1', [
      { itemId: 'a', title: 'A', durationSeconds: 10 },
      { itemId: 'b', title: 'B', durationSeconds: 10 },
      { itemId: 'c', title: 'C', durationSeconds: 10 },
    ]);
    jamStore.attach(jam.id, '1', socket());
    await jamStore.transport(jam.id, '1', { type: 'play' });
    return jam.id;
  }

  test('a report that lands just past the boundary moves one track, not two', async () => {
    // The ordinary case, every song, every room with a listener: the client's
    // `ended` arrives a moment after the server's own projection agrees the
    // track is over. Advancing for the correction AND again for the report is
    // how a room skips every other song.
    const id = await threeTenSecondTracks();
    ticker.advance(10_200);
    await jamStore.transport(id, '1', { type: 'next' });
    assert.equal((await settled(id)).current.index, 1, 'the room skipped a song');

    // And the correction must not also be filed away as something still to be
    // reported — the only client that was going to report it just did.
    await jamStore.transport(id, '1', { type: 'next' });
    assert.equal((await settled(id)).current.index, 2, 'a deliberate press was eaten');
  });

  test('a command the room refused leaves nothing behind for the next one', async () => {
    // A rejected command still runs the correction at the top of the write,
    // and nothing it touched is persisted or announced. Filing that away would
    // hand any member a way to eat the leader's next button press.
    const id = await threeTenSecondTracks();
    ticker.advance(10_200);
    const denied = await jamStore.transport(id, 'stranger', { type: 'pause' });
    assert.equal(denied.ok, false);

    await settled(id); // somebody opens the room; the correction is written down
    await jamStore.transport(id, '1', { type: 'next' });

    assert.equal((await settled(id)).current.index, 2, 'the refused command ate the next one');
  });

  test('the server getting there first does not make the client skip a song', async () => {
    // The client sends a bare `next` on `ended` — it carries no index, so
    // without the guard it means "advance from wherever you are now", and the
    // room jumps from track 0 straight to track 2.
    const id = await threeTenSecondTracks();
    ticker.advance(11_100);
    await ticker.fire();
    assert.equal((await settled(id)).current.index, 1, 'the backstop should have moved it');

    const before = (await settled(id)).seq;

    ticker.advance(300); // the client's report arrives just behind
    const out = await jamStore.transport(id, '1', { type: 'next' });

    assert.equal(out.ok, true, 'the client asked for a state it is now in; that is not a failure');
    const after = await settled(id);
    assert.equal(after.current.index, 1);
    // Nothing happened, so nothing is written and nothing is announced. Once
    // per song per room, a rewrite of the file every other room shares and an
    // identical snapshot pushed down every open stream is not nothing.
    assert.equal(after.seq, before, 'a command that changed nothing still renumbered the room');
  });

  test('the client reporting the end first leaves the backstop nothing to fire at', async () => {
    // Deliberately just INSIDE track 0, which is where a client's `ended`
    // really lands: its audio finishes a hair before the server's projection
    // says so. Reported from past the boundary and the server's own correction
    // is what moves the room, which is a different test.
    const id = await threeTenSecondTracks();
    ticker.advance(9_800);
    await jamStore.transport(id, '1', { type: 'next' });
    assert.equal((await settled(id)).current.index, 1);

    // One timer, re-aimed at the end of track 1. Checked directly: the old
    // backstop surviving alongside the new one is invisible in the index,
    // because by the time it fired it would find nothing to do anyway.
    assert.equal(ticker.pending, 1, 'the backstop for a track nobody is on any more is still armed');

    ticker.advance(5_000); // past where track 0's backstop would have gone off
    assert.equal(await ticker.fire(), 0);
    assert.equal((await settled(id)).current.index, 1, 'the backstop advanced a track nobody finished');
  });

  test('the backstop holds off for a second so the client can get there first', async () => {
    // Without the head start the server fires at the exact instant the audio
    // ends, and every single track becomes a race the client can only lose to
    // network latency.
    const id = await threeTenSecondTracks();
    ticker.advance(10_200); // the track is over; the client's report is in flight
    assert.equal(await ticker.fire(), 0, 'the backstop fired before the client had a chance');
    // Read raw, not through `getJam`: a read heals on its own, and it is the
    // timer's restraint that is on trial here.
    assert.equal((await readFileRoom(id)).current.index, 0, 'the backstop moved the room already');

    ticker.advance(1_000);
    assert.equal(await ticker.fire(), 1, 'and then it does step in');
  });

  test('only one next is ever swallowed, so a real double-press still lands', async () => {
    const id = await threeTenSecondTracks();
    ticker.advance(11_100);
    await ticker.fire(); // server advanced to 1

    await jamStore.transport(id, '1', { type: 'next' }); // swallowed: the end report
    await jamStore.transport(id, '1', { type: 'next' }); // a person pressing the button
    assert.equal((await settled(id)).current.index, 2);
  });

  test('the swallow only applies to the track the server actually advanced to', async () => {
    const id = await threeTenSecondTracks();
    ticker.advance(11_100);
    await ticker.fire(); // the backstop moved the room to track 1

    // Somebody drove the room somewhere else in the meantime, so the pending
    // "we already handled that end" no longer describes where the room is.
    await jamStore.transport(id, '1', { type: 'jump', index: 0 });
    await jamStore.transport(id, '1', { type: 'next' });

    assert.equal((await settled(id)).current.index, 1, 'a deliberate next was thrown away');
  });

  test('a next long after the server advanced is a person, not a report', async () => {
    const id = await threeTenSecondTracks();
    ticker.advance(11_100);
    await ticker.fire();

    ticker.advance(6_000); // beyond any plausible round trip
    await jamStore.transport(id, '1', { type: 'next' });
    assert.equal((await settled(id)).current.index, 2);
  });
});

describe('an empty room does not play', () => {
  let ticker;
  before(() => {
    ticker = takeOverTheClock();
  });
  beforeEach(() => ticker.reset());
  after(() => ticker.restore());

  /** A room with two tracks, playing, one person listening. Deliberately with
   *  no `durationSeconds`: this suite is about presence, and a duration would
   *  let the queue advance underneath the assertions. */
  async function playingRoom() {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'Ruta', mode: 'everyone' });
    const detach = jamStore.attach(jam.id, '1', socket());
    await jamStore.addTracks(jam.id, '1', [
      { itemId: 'a', title: 'One' },
      { itemId: 'b', title: 'Two' },
    ]);
    await jamStore.transport(jam.id, '1', { type: 'play' });
    return { id: jam.id, detach };
  }

  test('the last listener leaving does not stop the music on the spot', async () => {
    const { id, detach } = await playingRoom();
    ticker.advance(3_000);
    detach();

    const room = await settled(id);
    assert.equal(room.current.isPlaying, true, 'paused the instant the socket dropped');
  });

  test('a reconnect inside the grace period costs nothing at all', async () => {
    // The case this protects: one listener, on a motorbike, through a tunnel.
    // EventSource reconnects by itself, and pausing and resuming around that
    // put them back three seconds adrift with an audible jump.
    const { id, detach } = await playingRoom();
    const before = (await settled(id)).seq;

    ticker.advance(3_000);
    detach();
    ticker.advance(3_000);
    // Three seconds of tunnel: whatever the room does in that window is what
    // the listener comes back to, so nothing may be due yet.
    assert.equal(await ticker.fire(), 0, 'something was already due three seconds in');

    jamStore.attach(id, '1', socket()); // EventSource came back on its own
    // And the countdown is gone rather than left to expire on a full room.
    assert.equal(ticker.pending, 0, 'a timer was left running for a room somebody is in');

    ticker.advance(30_000);
    await ticker.fire();

    const room = await settled(id);
    assert.equal(room.current.isPlaying, true);
    assert.equal(room.seq, before, 'a reconnect must not write to the file every other room shares');
  });

  test('a countdown that expires on a room somebody refilled does not stop it', async () => {
    // The narrow one: the grace expires and its write goes into the lock queue
    // behind another, and by the time it runs somebody is back in the room.
    // Cancelling on arrival cannot help here — the timer already fired.
    const { id, detach } = await playingRoom();
    detach();
    ticker.advance(11_000);

    const queueing = jamStore.addTracks(id, '1', [{ itemId: 'c', title: 'Three' }]);
    const firing = ticker.fire(); // the pause is now queued behind that write
    jamStore.attach(id, '1', socket()); // and somebody walks in before it runs
    await queueing;
    await firing;

    assert.equal((await settled(id)).current.isPlaying, true, 'stopped a room with a listener in it');
  });

  test('a room still empty when the grace runs out freezes where the clock got to', async () => {
    const { id, detach } = await playingRoom();
    ticker.advance(5_000);
    detach();
    ticker.advance(11_000);
    await ticker.fire();

    const paused = await settled(id);
    assert.equal(paused.current.isPlaying, false);
    // Where playback actually reached, not rewound to where play was pressed
    // and not rewound to the moment the last person left either: the grace
    // period is real time and the room really was still running through it.
    // That is the bounded cost of the grace — at most ten seconds of a queue
    // spent on nobody, once, per emptying.
    assert.equal(paused.current.positionMs, 16_000);
  });

  test('and its clock stops with it, which is the whole point', async () => {
    const { id, detach } = await playingRoom();
    detach();
    ticker.advance(11_000);
    await ticker.fire();

    const first = jamStore.projectedPositionMs(await settled(id));
    ticker.advance(600_000);
    assert.equal(jamStore.projectedPositionMs(await settled(id)), first);
  });

  test('the first person back picks it up rather than restarting it', async () => {
    const { id, detach } = await playingRoom();
    ticker.advance(5_000);
    detach();
    ticker.advance(11_000);
    await ticker.fire();

    const frozenAt = (await settled(id)).current.positionMs;
    ticker.advance(600_000); // the room sat there for ten minutes

    jamStore.attach(id, '1', socket());
    const back = await settled(id);
    assert.equal(back.current.isPlaying, true);
    // Ten minutes of being nowhere does not cost the room ten minutes of song.
    assert.equal(back.current.positionMs, frozenAt);
  });

  test('a pause somebody pressed on purpose outlives the room emptying', async () => {
    const { id, detach } = await playingRoom();
    ticker.advance(5_000);
    await jamStore.transport(id, '1', { type: 'pause' });

    detach();
    ticker.advance(11_000);
    await ticker.fire(); // the grace expires on an already-stopped room

    jamStore.attach(id, '1', socket());
    const still = await settled(id);
    assert.equal(still.current.isPlaying, false, 'walking in undid a deliberate pause');
  });

  test('one of two listeners leaving starts no countdown', async () => {
    const { id, detach } = await playingRoom();
    jamStore.attach(id, 'ears', socket());

    detach();
    // Checked directly, not inferred from the room still playing: a countdown
    // that fired and then found somebody home would leave that unchanged too,
    // and this test claims the countdown never started.
    assert.equal(ticker.pending, 0, 'a countdown was armed for a room with a listener in it');

    ticker.advance(60_000);
    await ticker.fire();
    assert.equal((await settled(id)).current.isPlaying, true);
  });

  test('the reason the room stopped is never written to disk', async () => {
    const { id, detach } = await playingRoom();
    detach();
    ticker.advance(11_000);
    await ticker.fire();

    const onDisk = await readFileRoom(id);
    // Persisted, it would survive a restart — and after a restart nobody is
    // present, so the first person to open the app would be greeted by a room
    // that had been sitting still for days starting to play at them.
    assert.deepEqual(
      Object.keys(onDisk).sort(),
      ['createdAt', 'current', 'id', 'members', 'mode', 'name', 'ownerId', 'queue', 'seq'],
    );
  });

  test('a write that fails leaves the countdown running rather than giving up', async () => {
    // One transient disk error at the wrong moment used to strand a room
    // playing to nobody indefinitely: the countdown is one-shot and has
    // already deleted itself, and nothing re-arms until somebody both arrives
    // and leaves again — which may be never.
    const { detach } = await playingRoom();
    detach();
    ticker.advance(11_000);

    // Turn the store's file into a directory so the read-modify-write throws.
    await rm(process.env.JAM_FILE, { force: true });
    await mkdir(process.env.JAM_FILE);
    try {
      await ticker.fire();
      assert.equal(ticker.pending, 1, 'the countdown gave up after one failed write');
    } finally {
      await rm(process.env.JAM_FILE, { recursive: true, force: true });
    }
  });

  test('a restart forgets it, so the first arrival is met with silence', async () => {
    // The `pausedWhenEmptied` in the fixture is a decoy: a build that trusted
    // anything on disk about why a room stopped would resume here.
    const oldRoom = freshId('old');
    const jam = {
      id: oldRoom,
      name: 'Ruta',
      mode: 'everyone',
      ownerId: '1',
      createdAt: 0,
      members: [{ userId: '1', name: 'K', role: 'owner', invitedAt: 0, acceptedAt: 1 }],
      queue: [{ itemId: 'a', title: 'One', addedBy: '1' }],
      current: { index: 0, positionMs: 12_000, isPlaying: false, at: 0 },
      pausedWhenEmptied: true,
      seq: 7,
    };
    await writeFile(process.env.JAM_FILE, JSON.stringify({ jams: [jam] }, null, 2), 'utf8');

    // A second live copy of the module, with its own module state — which is
    // the point. Its clock is taken over too: left on the real one it would
    // arm real timers against the shared temp file for the rest of the run.
    const restarted = await import(`./jam.mjs?restart=${Date.now()}`);
    const theirs = takeOverTheClock(restarted);
    try {
      restarted.attach(oldRoom, '1', socket());
      const room = await restarted.getJam(oldRoom);
      assert.equal(room.current.isPlaying, false, 'a room parked days ago started playing by itself');
    } finally {
      theirs.restore();
    }
  });

  test('a queue cleared while nobody was there does not arm the next arrival', async () => {
    // The bug this replaces: the empty-queue path returned before clearing the
    // flag, so the room stayed marked as ours to resume with people standing
    // in it, and a later arrival walked in to music starting by itself.
    const { id, detach } = await playingRoom();
    detach();
    ticker.advance(11_000);
    await ticker.fire(); // auto-paused, and the room is ours to resume

    await jamStore.removeTrack(id, '1', 0);
    await jamStore.removeTrack(id, '1', 0);
    const quiet = (await settled(id)).seq;

    const first = jamStore.attach(id, '1', socket());
    const arrived = await settled(id);
    assert.equal(arrived.current.isPlaying, false, 'resumed into an empty queue');
    // Not merely corrected afterwards: never started. Starting an empty queue
    // and having the next read undo it is two writes to the shared file and a
    // snapshot that flickers into playing on every client in the room.
    assert.equal(arrived.seq, quiet, 'the room was started and then quietly unstarted');

    // Now the room fills up again and empties again, this time while stopped —
    // so nothing should be marked as ours.
    await jamStore.addTracks(id, '1', [{ itemId: 'c', title: 'Three' }]);
    first();
    ticker.advance(11_000);
    await ticker.fire();

    jamStore.attach(id, '1', socket());
    assert.equal((await settled(id)).current.isPlaying, false, 'a stale flag started the music');
  });
});

describe('leaving a room hangs up on the leaver', () => {
  let ticker;
  before(() => {
    ticker = takeOverTheClock();
  });
  beforeEach(() => ticker.reset());
  after(() => ticker.restore());

  async function roomOfTwo() {
    const { jam } = await jamStore.createJam({ ownerId: '1', ownerName: 'K', name: 'M', mode: 'everyone' });
    await jamStore.inviteMembers(jam.id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(jam.id, '2', true);
    await jamStore.addTracks(jam.id, '1', [{ itemId: 'a', title: 'A' }]);
    return jam.id;
  }

  test('leaving closes the stream instead of leaving it open', async () => {
    const id = await roomOfTwo();
    const theirs = socket();
    jamStore.attach(id, '2', theirs);

    await jamStore.leaveJam(id, '2');

    assert.equal(theirs.ended, true);
    assert.equal((await jamStore.currentSnapshot(id)).present.includes('2'), false);
  });

  test('and the server stops pushing the room at somebody it threw out', async () => {
    const id = await roomOfTwo();
    const theirs = socket();
    jamStore.attach(id, '2', theirs);
    await jamStore.leaveJam(id, '2');
    const seen = theirs.sent.length;

    await jamStore.addTracks(id, '1', [{ itemId: 'b', title: 'B' }]);

    assert.equal(theirs.sent.length, seen, 'a former member was still being sent the room');
  });

  test('a room emptied by its last guest leaving really does count as empty', async () => {
    // The ghost stream was what stopped this working: presence IS the socket,
    // so a socket nobody closed meant the room was never empty and the music
    // never stopped.
    const id = await roomOfTwo();
    jamStore.attach(id, '2', socket());
    await jamStore.transport(id, '2', { type: 'play' });

    await jamStore.leaveJam(id, '2');
    ticker.advance(11_000);
    await ticker.fire();

    assert.equal((await settled(id)).current.isPlaying, false);
  });

  test('being removed by the owner hangs up too', async () => {
    const id = await roomOfTwo();
    const theirs = socket();
    jamStore.attach(id, '2', theirs);

    await jamStore.removeMember(id, '1', '2');

    assert.equal(theirs.ended, true);
    assert.equal((await jamStore.currentSnapshot(id)).present.includes('2'), false);
  });

  test('a refused removal leaves the stream alone', async () => {
    const id = await roomOfTwo();
    const theirs = socket();
    jamStore.attach(id, '2', theirs);

    // '2' is not the owner, so this is forbidden — and it names '2' as the
    // target, so a hang-up that fired regardless of the outcome would throw
    // them out of a room nobody was entitled to remove them from.
    await jamStore.removeMember(id, '2', '2');

    assert.equal(theirs.ended, false);
    assert.equal((await jamStore.currentSnapshot(id)).present.includes('2'), true);
  });

  test('a detach from before the hang-up cannot disturb the stream that replaced it', async () => {
    // The dead socket's own 'close' can arrive at any point, including after
    // its owner has been let back in on a new connection. It holds a closure
    // over the response it was created for; matching on that response rather
    // than on the user is what keeps it from speaking for its successor.
    const id = await roomOfTwo();
    const owner = socket();
    jamStore.attach(id, '1', owner);
    const staleDetach = jamStore.attach(id, '2', socket());
    await jamStore.leaveJam(id, '2');

    await jamStore.inviteMembers(id, '1', [{ userId: '2', name: 'B' }]);
    await jamStore.respondToInvite(id, '2', true);
    jamStore.attach(id, '2', socket()); // back, on a fresh connection
    await settled(id);
    const heard = owner.sent.length;

    staleDetach();
    await settled(id);

    assert.equal(owner.sent.length, heard, 'a dead socket closing spoke for the live one');
    assert.equal((await jamStore.currentSnapshot(id)).present.includes('2'), true);
  });

  test('the close handler arriving after the hang-up does not re-announce the room', async () => {
    const id = await roomOfTwo();
    const owner = socket();
    jamStore.attach(id, '1', owner);
    const detach = jamStore.attach(id, '2', socket());

    await jamStore.leaveJam(id, '2');
    await settled(id); // let the presence broadcast land
    const heard = owner.sent.length;

    detach(); // the socket's own 'close', arriving behind the hang-up
    await settled(id);

    assert.equal(owner.sent.length, heard, 'the room was announced twice for one departure');
  });
});
