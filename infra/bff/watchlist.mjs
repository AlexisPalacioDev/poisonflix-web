// Per-user "Mi lista" (watchlist) store: titles a user saved to request/download
// LATER, decoupled from the immediate "Pedir" flow (which downloads now). File-
// backed like invites.mjs (the BFF is otherwise stateless), zero runtime deps.
// Keyed by the Jellyseerr user id the BFF derives from the session cookie
// (server.mjs `resolveUser`), so a user can only ever read/write their OWN list -
// the browser never supplies the identity.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const FILE = process.env.WATCHLIST_FILE || '/data/watchlist.json';

/** Serializes every read-modify-write so concurrent add/remove can't clobber
 * each other (same mutex shape as invites.mjs). */
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// On-disk shape: { "<userId>": [ entry, ... ] }. A whole-file object keyed by
// user id (not one file per user) keeps it as simple as invites.json.
async function loadAll() {
  try {
    const raw = await readFile(FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function persistAll(all) {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
  await rename(tmp, FILE); // atomic swap so a crash mid-write can't corrupt the file
}

// A movie and a TV show can share the same TMDB id, so identity is the pair
// (tmdbId, mediaType) - never tmdbId alone.
function sameEntry(a, b) {
  return a.tmdbId === b.tmdbId && a.mediaType === b.mediaType;
}

/** Every saved entry for one user, newest first. */
export function getWatchlist(userId) {
  return withLock(async () => {
    const all = await loadAll();
    return Array.isArray(all[String(userId)]) ? all[String(userId)] : [];
  });
}

/**
 * Add a title to the user's list (idempotent: re-adding the same
 * tmdbId+mediaType just refreshes its position, never duplicates). Returns the
 * updated list.
 */
export function addToWatchlist(userId, entry, nowIso) {
  return withLock(async () => {
    const all = await loadAll();
    const key = String(userId);
    const current = Array.isArray(all[key]) ? all[key] : [];
    const withoutDupe = current.filter((e) => !sameEntry(e, entry));
    const next = [{ ...entry, addedAt: nowIso }, ...withoutDupe];
    all[key] = next;
    await persistAll(all);
    return next;
  });
}

/** Remove a title. Returns the updated list. */
export function removeFromWatchlist(userId, tmdbId, mediaType) {
  return withLock(async () => {
    const all = await loadAll();
    const key = String(userId);
    const current = Array.isArray(all[key]) ? all[key] : [];
    const next = current.filter((e) => !sameEntry(e, { tmdbId, mediaType }));
    all[key] = next;
    await persistAll(all);
    return next;
  });
}
