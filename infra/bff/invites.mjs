// Invite-code store for self-service registration. File-backed (the BFF is
// otherwise stateless), zero runtime dependencies. All mutations are serialized
// through a single promise chain so a single-use code can never be consumed
// twice by two interleaved requests (Node is single-threaded, but `await`s in a
// handler yield the event loop — the mutex closes that window).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const FILE = process.env.INVITES_FILE || '/data/invites.json';

/** Serializes every read-modify-write so consumption is atomic. */
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  // Keep the chain alive but swallow errors so one failure doesn't poison it.
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
    return Array.isArray(data?.invites) ? data.invites : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function persist(invites) {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ invites }, null, 2), 'utf8');
  await rename(tmp, FILE); // atomic swap so a crash mid-write can't corrupt the file
}

/** Human-friendly, hard-to-guess: 12 hex chars grouped as XXXX-XXXX-XXXX. */
function generateCode() {
  const hex = randomBytes(6).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function isExpired(invite, now) {
  return invite.expiresAt != null && Date.parse(invite.expiresAt) <= now;
}

export function inviteStatus(invite, now = Date.now()) {
  if (invite.usedBy) return 'used';
  if (isExpired(invite, now)) return 'expired';
  return 'active';
}

/** Create a new code. `expiresInDays` is optional (null = never expires). */
export function createInvite({ createdBy, expiresInDays = null, nowIso }) {
  return withLock(async () => {
    const invites = await load();
    const expiresAt =
      expiresInDays == null
        ? null
        : new Date(Date.parse(nowIso) + expiresInDays * 86_400_000).toISOString();
    const invite = {
      code: generateCode(),
      createdBy,
      createdAt: nowIso,
      expiresAt,
      usedBy: null,
      usedAt: null,
    };
    invites.push(invite);
    await persist(invites);
    return invite;
  });
}

export function listInvites(now = Date.now()) {
  return withLock(async () => {
    const invites = await load();
    return invites.map((inv) => ({ ...inv, status: inviteStatus(inv, now) }));
  });
}

/** Delete an unused code. Returns true if it existed and was removed. */
export function revokeInvite(code) {
  return withLock(async () => {
    const invites = await load();
    const idx = invites.findIndex((i) => i.code === code && !i.usedBy);
    if (idx === -1) return false;
    invites.splice(idx, 1);
    await persist(invites);
    return true;
  });
}

/**
 * Atomically validate + consume a code in one locked section.
 * Returns { ok: true } on success, or { ok: false, reason } — reason is one of
 * 'not_found' | 'expired' | 'used'. The code is only marked used on ok.
 */
export function consumeInvite({ code, usedBy, nowIso }) {
  return withLock(async () => {
    const now = Date.parse(nowIso);
    const invites = await load();
    const invite = invites.find((i) => i.code === code);
    if (!invite) return { ok: false, reason: 'not_found' };
    if (invite.usedBy) return { ok: false, reason: 'used' };
    if (isExpired(invite, now)) return { ok: false, reason: 'expired' };
    invite.usedBy = usedBy;
    invite.usedAt = nowIso;
    await persist(invites);
    return { ok: true };
  });
}

/** Peek without consuming — used to fail fast before touching Jellyfin. */
export function checkInvite(code) {
  return withLock(async () => {
    const invites = await load();
    const invite = invites.find((i) => i.code === code);
    if (!invite) return { ok: false, reason: 'not_found' };
    const status = inviteStatus(invite);
    if (status === 'used') return { ok: false, reason: 'used' };
    if (status === 'expired') return { ok: false, reason: 'expired' };
    return { ok: true };
  });
}
