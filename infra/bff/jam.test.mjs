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
import { mkdtemp, rm } from 'node:fs/promises';
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
