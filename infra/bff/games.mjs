// poisonflix-bff games — the ROM library behind "modo gamer".
//
// There is deliberately NO games-worker. Música needs one because it fetches
// from YouTube, remuxes, and writes into the Jellyfin library; games only need
// a directory listed and a file streamed. A second container would add a hop,
// a build, and a restart policy to `readdir` + `createReadStream`.
//
// The request handler lives HERE rather than in server.mjs (where handleMusic
// and handleJam live) for one reason: server.mjs calls `server.listen()` at
// import time, so a test that imports it opens a real socket and a real
// Jellyseerr dependency. Keeping the handler in a plain module lets
// `node --test` drive real HTTP — Range requests included — against the exact
// code production runs, instead of a re-implementation that can drift from it.
//
// Zero dependencies, like the rest of this service.

import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Read at import time (same convention as jam.mjs's JAM_FILE) so a test can
// point it at a fixture directory before importing this module.
const GAMES_DIR = process.env.GAMES_DIR || '/games';

// The folder name IS the system, and these are EmulatorJS's own core names —
// they are handed to the emulator verbatim, so the casing is not cosmetic:
// `segamd` would not start. Anything not on this list is ignored in silence:
// a media disk collects `bios/`, `saves/`, `covers/` and lost+found, and none
// of that is a console.
const SYSTEMS = new Set([
  'nes',
  'snes',
  'n64',
  // Game Boy Color has no core of its own — gambatte declares gb, gbc and dmg
  // as extensions, so .gbc files belong in this folder. A gbc entry was on this
  // list and every ROM under it listed fine and then failed to boot.
  'gb',
  'gba',
  'nds',
  'psx',
  'psp',
  'segaMD',
  'segaCD',
  'segaSaturn',
  'segaGG',
  'segaMS',
  'sega32x',
  'atari2600',
  'atari7800',
  'lynx',
  'jaguar',
  'vb',
  'pce',
  'ngp',
  'ws',
  '3do',
  'arcade',
  'coleco',
  'c64',
]);

// Not an allowlist of ROM extensions — there are hundreds and they change per
// system. This is the companion junk that sits NEXT TO a ROM in every real
// library: box art, scraper metadata, and the save/state files emulators drop
// beside the game they belong to.
//
// A denylist here is a loaded gun, and it went off once already: `.md` was on
// this list as "markdown" and it is the canonical Mega Drive extension, so
// every single segaMD ROM vanished from the shelf while segaMD sat in SYSTEMS
// looking supported. `.dat` came off for the same reason. NOTHING goes on this
// list without checking it against the systems above first — a wrong entry
// does not fail, it hides an entire console in silence.
const IGNORED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.xml',
  '.txt',
  '.nfo',
  '.db',
  '.srm',
  '.sav',
  '.state',
]);

/** Ids travel in a query string, so base64url (no `+`, `/` or `=`) and no escaping. */
function encodeId(relPath) {
  return Buffer.from(relPath, 'utf8').toString('base64url');
}

/**
 * The inverse, or null.
 *
 * The strict charset test and the re-encode comparison are not belt and
 * braces: `Buffer.from(s, 'base64url')` SKIPS characters it does not
 * understand instead of failing, so many different id strings decode to the
 * same path (and a path can carry bytes that never survive a UTF-8 round
 * trip). Insisting the id is exactly what `encodeId` would have produced makes
 * the mapping one-to-one, which is what every check downstream assumes.
 */
function decodeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const rel = Buffer.from(id, 'base64url').toString('utf8');
  if (encodeId(rel) !== id) return null;
  return rel;
}

/**
 * "Super_Mario_Bros_3_(USA)_[!].nes" -> "Super Mario Bros 3".
 *
 * Region and dump tags are how ROM sets have been named since the nineties;
 * they carry nothing a person picking a game wants to read.
 */
function titleOf(file) {
  const stem = file.replace(/\.[^.]+$/, '');
  const cleaned = stem
    .replace(/[[(][^)\]]*[)\]]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A file named nothing but tags would otherwise become an unclickable blank.
  return cleaned || stem;
}

/**
 * Validate one `<system>/<file>` path and describe the file behind it, or
 * return null. Every path that reaches the disk goes through here, whether it
 * came from a client id or from our own `readdir` — so the library can never
 * list something `/rom` would refuse to serve, or vice versa.
 *
 * `root` must already be a realpath: the containment checks compare strings,
 * and a symlinked GAMES_DIR would fail every one of them.
 */
async function describe(rel, root) {
  if (rel.includes('\0')) return null;
  // A backslash is an ordinary filename character on Linux, so `..\..\etc` is
  // not traversal here — but the id also reaches a Windows dev box's tooling,
  // and a separator that means one thing to `path` and another to the OS is
  // exactly the ambiguity these checks exist to remove.
  if (rel.includes('\\')) return null;

  const segments = rel.split('/');
  // The layout is flat by contract: one folder per system, files inside it.
  // Anything deeper or shallower is not a game, and refusing it here is what
  // makes `../../etc/passwd` a non-event rather than a near miss.
  if (segments.length !== 2) return null;
  const [system, file] = segments;
  if (!SYSTEMS.has(system)) return null;
  if (!file || file === '.' || file === '..') return null;
  if (file.startsWith('.')) return null;
  const dot = file.lastIndexOf('.');
  if (dot > 0 && IGNORED_EXTENSIONS.has(file.slice(dot).toLowerCase())) return null;

  const full = resolve(root, rel);
  // Containment check #1: the NAME stays inside the library.
  if (!full.startsWith(root + sep)) return null;

  // Containment check #2, and the reason there are two: the first proves the
  // NAME is inside, this proves the name does not RESOLVE outside. A symlink at
  // `nes/free-passwords.nes -> /etc/passwd` passes #1 without a complaint.
  //
  // What this does NOT prove is that the file's contents originate inside: a
  // HARDLINK to an outside file is a genuine directory entry here, and no
  // amount of path resolution can tell it apart from a real one. That is
  // accepted, not overlooked — the mount is read-only for this container, so
  // planting one requires write access to the library on the host, and anyone
  // with that could simply copy the file in instead.
  const real = await realpath(full).catch(() => null);
  if (!real || !real.startsWith(root + sep)) return null;

  const info = await stat(real).catch(() => null);
  if (!info || !info.isFile()) return null;

  return {
    id: encodeId(rel),
    title: titleOf(file),
    system,
    sizeBytes: info.size,
    path: real,
  };
}

/**
 * The library root as a realpath, or null when it cannot be read.
 *
 * `quiet` is for the /rom path, where a bad id is the ordinary case and a log
 * line per probe would be noise. /library logs, because there the difference
 * matters — see listGames.
 */
async function libraryRoot(quiet = false) {
  try {
    return await realpath(GAMES_DIR);
  } catch (err) {
    // An unreadable library and an empty one look IDENTICAL from the SPA: both
    // are an empty shelf. This repo has collected comments about exactly that
    // class of defect, and the realistic failure here is not an unset env var
    // (compose's `${DATA_DIR:?}` catches that) but `$DATA_DIR/games` simply
    // not existing on the host — in which case Docker's create_host_path
    // conjures an empty directory and everything stays green forever. One line
    // is what makes `docker compose logs bff` able to tell the two apart.
    if (!quiet) logError('games.library', err, { gamesDir: GAMES_DIR });
    return null;
  }
}

/**
 * Every playable file, flat. An empty library is an ordinary state (nobody has
 * copied a ROM yet) and answers `[]`; a library that cannot be READ answers
 * `[]` too, but leaves a log line behind first.
 */
export async function listGames() {
  const root = await libraryRoot();
  if (!root) return [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    // Mounted but unreadable — almost always the container's uid not matching
    // the ROMs' owner. Same reasoning as above: silence would make this
    // indistinguishable from "no games yet".
    logError('games.library', err, { gamesDir: GAMES_DIR });
    return [];
  }

  const games = [];
  for (const entry of entries) {
    if (!SYSTEMS.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const files = await readdir(join(root, entry.name)).catch((err) => {
      logError('games.system', err, { system: entry.name });
      return [];
    });
    for (const file of files) {
      const game = await describe(`${entry.name}/${file}`, root);
      if (!game) continue;
      games.push({
        id: game.id,
        title: game.title,
        system: game.system,
        sizeBytes: game.sizeBytes,
      });
    }
  }
  // Stable order so the shelf does not reshuffle between loads for no reason
  // (readdir order is whatever the filesystem feels like).
  games.sort((a, b) => a.system.localeCompare(b.system) || a.title.localeCompare(b.title));
  return games;
}

/** Resolve a client-supplied id to a real file, or null. */
export async function resolveRom(id) {
  const rel = decodeId(id);
  if (rel === null) return null;
  const root = await libraryRoot(true);
  if (!root) return null;
  return await describe(rel, root);
}

/**
 * Single-range parsing (RFC 7233 §3.1).
 *
 * @returns {null | 'unsatisfiable' | { start: number, end: number }}
 *   null means "answer the whole thing with 200", which is always legal — a
 *   server may ignore Range entirely. It is also the answer for a multi-range
 *   request: a `multipart/byteranges` body is a lot of machinery, and no
 *   EmulatorJS path is known to send one. That last part is an assumption, so
 *   it is worth knowing what it costs if it is wrong — the client gets the
 *   whole file instead of two slices of it, which is slow, not broken.
 */
export function parseRange(header, size) {
  if (!header) return null;
  // Case-insensitive unit and optional whitespace around the `=` and the
  // digits, because RFC 7230 makes the unit token case-insensitive and allows
  // optional whitespace there. A stricter regex is not "safe" here: every
  // shape it fails to parse falls through to a 200, and a 200 on a PS1 image
  // means pushing 600 MB the client did not ask for. Leading zeroes are
  // tolerated for the same reason.
  //
  // Digits are unbounded on purpose. A length cap looks like the careful
  // choice and is the opposite: `bytes=0000000000000000005-9` is a legal (if
  // silly) request that a capped pattern rejects into a whole-file 200. Past
  // 2^53 `Number` stops being exact, but it stays MUCH larger than any file,
  // so `start >= size` and the `Math.min` clamp below both still decide
  // correctly — precision only matters near `size`, and these values are not.
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header));
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (size === 0) return 'unsatisfiable';

  if (rawStart === '') {
    // Suffix form: `bytes=-500` is the LAST 500 bytes, not the first 500.
    const wanted = Number(rawEnd);
    if (wanted === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

// Same one-line JSON shape server.mjs logs with (see `logError` there).
// Duplicated rather than imported because importing server.mjs starts a
// listening socket — the very thing this module is kept separate to avoid.
function logError(scope, err, detail) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ at: new Date().toISOString(), level: 'error', scope, message, ...detail }),
  );
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function sendRom(req, res, id) {
  const game = id ? await resolveRom(id) : null;
  // One answer for "no such file", "not a system we know", "outside the
  // library" and "that symlink leaves the disk". Telling the caller which of
  // those it was is how a probe maps the host's filesystem.
  if (!game) return sendJson(res, 404, { error: 'not found' });

  // Range support is not a nicety here: a PS1 image is 600+ MB and EmulatorJS
  // asks for it in pieces. Without `Accept-Ranges` the browser has to pull the
  // whole disc before the emulator boots, and a dropped connection restarts
  // from zero.
  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    // Not cached. A couple of these would evict everything else the browser is
    // holding, and without an ETag/Last-Modified there is nothing for the
    // client to validate a resumed Range against — a stale partial stitched
    // onto a fresh one is a corrupt image, which presents as a game that
    // simply refuses to boot. Re-downloading is the cheaper failure.
    'cache-control': 'no-store',
  };

  const range = parseRange(req.headers['range'], game.sizeBytes);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${game.sizeBytes}` });
    return res.end();
  }

  if (game.sizeBytes === 0) {
    res.writeHead(200, { ...headers, 'content-length': '0' });
    return res.end();
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : game.sizeBytes - 1;
  headers['content-length'] = String(end - start + 1);
  if (range) headers['content-range'] = `bytes ${start}-${end}/${game.sizeBytes}`;
  res.writeHead(range ? 206 : 200, headers);

  // HEAD gets every header and no body. RFC 7231 §4.3.2 requires a resource
  // that answers GET to answer HEAD identically, and it is the cheapest way
  // for a client to learn a 600 MB image's size and that Range works before
  // committing to the download. Answering 404 (which this did) told a probing
  // client the ROM did not exist.
  if (req.method === 'HEAD') return res.end();

  // `pipeline`, not `.pipe()` — the same lesson `handleMusic` documents at
  // length in server.mjs. `.pipe()` does not forward source errors, so with no
  // 'error' listener a read that fails mid-transfer becomes an
  // uncaughtException and takes the WHOLE BFF down, every in-flight /radarr,
  // /sonarr and /bff request with it. A client abandoning a ROM transfer (the
  // player closed the emulator, the phone slept, the emulator seeked) is
  // routine, so `.pipe()` here would turn a routine event into a routine
  // outage. Headers are already sent, so there is nothing to report to the
  // client but a socket teardown; the point is that the process survives and
  // the failure leaves a line behind.
  try {
    await pipeline(createReadStream(game.path, { start, end }), res);
  } catch (err) {
    logError('games.rom', err, { system: game.system, start, end });
    res.destroy();
  }
}

/**
 * `/bff/games/*`. `subPath` is the part after `/bff/games`, and the caller has
 * already been authenticated — this module never sees a session and must never
 * be mounted before `resolveUser`.
 */
export async function handleGames(req, res, subPath, search) {
  // Explicit allowlist, like handleMusic: the set of things this can do stays
  // enumerable, and a typo becomes a 404 instead of a surprise. HEAD rides
  // along with GET because a read-only resource that refuses HEAD is lying
  // about what it has (see sendRom).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 404, { error: 'not found' });
  }

  if (subPath === '/library') {
    return sendJson(res, 200, { games: await listGames() });
  }

  if (subPath === '/rom') {
    const id = new URLSearchParams(search || '').get('id');
    return await sendRom(req, res, id);
  }

  return sendJson(res, 404, { error: 'not found' });
}
