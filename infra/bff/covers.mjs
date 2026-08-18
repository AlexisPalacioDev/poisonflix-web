// poisonflix-bff game covers — box art for the "modo gamer" shelf.
//
// A ROM library is a wall of filenames. The art lives in the `libretro-thumbnails`
// GitHub org: one repository per console, a `Named_Boxarts/` folder inside it,
// and a CDN in front of the same files. Nothing here scrapes: we ask GitHub for
// the LIST of names once per console (cheap, no images), match our filename
// against that list, and pull the single image we need from the CDN.
//
// Three rules shape every decision below, in this order:
//
//   1. NEVER take the BFF down. This process also serves Jellyseerr search and
//      ROM streaming to a household. GitHub being slow, rate-limited or gone is
//      an ordinary Tuesday, and the only acceptable answer is 404 + a log line.
//   2. NEVER show the wrong cover. A wrong box art is worse than no box art:
//      the shelf stops being trustworthy. Matching therefore refuses ties it
//      cannot break and refuses anything below a similarity floor.
//   3. NEVER hammer GitHub. Unauthenticated api.github.com allows 60 requests
//      per hour PER IP. A single shelf load asks for ~50 covers; without the
//      index cache the second page view of the day would be rate-limited, and
//      the rate limit is shared with anything else on this IP.
//
// One number worth knowing before building a shelf on top of this: libretro
// boxarts are full-size, 512x512 PNGs of 300-500 KB EACH. There is no resizing
// here — that needs an image library, and this service has no dependencies —
// so a page showing fifty covers at once is pulling twenty megabytes the first
// time. The week-long immutable Cache-Control is what makes that a one-off,
// and the client should still load them lazily.
//
// Zero dependencies, like the rest of this service.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Writable volume (`./bff/data:/data` in docker-compose.yml). NOT under /games:
// that mount is read-only by design, and a cache that needs write access to the
// ROM library would be a reason to make the library writable. It must not be.
//
// Nothing ever deletes from here, and that is a decision rather than an
// oversight: the cache is bounded by the LIBRARY, one image per ROM that has
// art, and a boxart is ~500 KB. A thousand-game library is half a gigabyte on
// the same disk that holds the ROMs themselves. An eviction policy would add a
// second thing that can be wrong (evicting what is on screen) to save space
// that is not scarce. `rm -rf` on this directory is a safe, complete reset.
const COVERS_DIR = process.env.GAMES_COVERS_DIR || '/data/games-covers';
// Overridable so the tests can point both at a local server and exercise the
// real network code path (timeouts, statuses, atomic writes) without touching
// GitHub — and without the suite depending on the internet being up.
const API_BASE = process.env.GAMES_COVERS_API || 'https://api.github.com';
const CDN_BASE = process.env.GAMES_COVERS_CDN || 'https://thumbnails.libretro.com';

/**
 * Our system folder -> libretro-thumbnails repositories.
 *
 * EVERY name here was verified with a real request; anything that 404'd is
 * absent on purpose, and an absent system answers a clean 404 instead of
 * burning a GitHub request on a repo that does not exist.
 *
 * Some of our folders cover two consoles, because EmulatorJS's core does
 * (`gb` runs Game Boy AND Game Boy Color through gambatte — see SYSTEMS in
 * games.mjs). libretro splits those into separate repositories, so the value is
 * a LIST and the index is their UNION, searched as one pool.
 *
 * Nothing routes a `.gbc` to the Color repository and a `.gb` to the other, and
 * nothing should pretend to: the two sets overlap, a name in both is the same
 * box in both, and when only one has it that is the one that answers. Ties are
 * broken by name (see `best`), not by repository.
 *
 * The CDN path is this same name with `_` turned back into a space.
 */
export const SYSTEM_REPOS = {
  nes: ['Nintendo_-_Nintendo_Entertainment_System'],
  snes: ['Nintendo_-_Super_Nintendo_Entertainment_System'],
  n64: ['Nintendo_-_Nintendo_64'],
  gb: ['Nintendo_-_Game_Boy_Color', 'Nintendo_-_Game_Boy'],
  gba: ['Nintendo_-_Game_Boy_Advance'],
  nds: ['Nintendo_-_Nintendo_DS'],
  vb: ['Nintendo_-_Virtual_Boy'],
  psx: ['Sony_-_PlayStation'],
  psp: ['Sony_-_PlayStation_Portable'],
  segaMD: ['Sega_-_Mega_Drive_-_Genesis'],
  segaCD: ['Sega_-_Mega-CD_-_Sega_CD'],
  segaSaturn: ['Sega_-_Saturn'],
  segaGG: ['Sega_-_Game_Gear'],
  segaMS: ['Sega_-_Master_System_-_Mark_III'],
  sega32x: ['Sega_-_32X'],
  atari2600: ['Atari_-_2600'],
  atari7800: ['Atari_-_7800'],
  lynx: ['Atari_-_Lynx'],
  jaguar: ['Atari_-_Jaguar'],
  pce: ['NEC_-_PC_Engine_-_TurboGrafx_16'],
  ngp: ['SNK_-_Neo_Geo_Pocket_Color', 'SNK_-_Neo_Geo_Pocket'],
  ws: ['Bandai_-_WonderSwan_Color', 'Bandai_-_WonderSwan'],
  '3do': ['The_3DO_Company_-_3DO'],
  coleco: ['Coleco_-_ColecoVision'],
  c64: ['Commodore_-_64'],
  // Both repos exist and both are indexed, but expect a lot of honest 404s
  // here: arcade ROMs are named after the MAME set (`sf2ce.zip`), while the
  // art is named after the game ("Street Fighter II' - Champion Edition").
  // Nothing short of shipping a MAME set-name table bridges that, and a
  // placeholder is a much better outcome than a fuzzy guess (rule 2).
  arcade: ['MAME', 'FBNeo_-_Arcade_Games'],
};

// A week. The upstream repos get a handful of commits a month, so a fresher
// index buys nothing and costs a GitHub request per console per refresh.
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// How long a "there is no cover for this game" answer sticks in memory. Without
// it, every shelf render re-runs the match (cheap) and, worse, re-asks the CDN
// for an image the index promised and the CDN does not have (not cheap).
const MISS_TTL_MS = 60 * 60 * 1000;
// After a 403/429 the whole index layer goes quiet: GitHub resets the counter
// hourly, and retrying inside that window only deepens the hole.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
// Same idea, per console, for every OTHER way a refresh can fail: a timeout, a
// GitHub 500, a repo that lost its Named_Boxarts folder. Without it a console
// with a broken index re-asks GitHub once per COVER — a single shelf load would
// spend the whole hourly allowance on a repo that is not going to answer, and
// take every other console down with it.
const INDEX_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

// Budgets, not guesses, because they ADD UP inside one request: the worst a
// cover request can cost is one index timeout plus one image timeout — 25
// seconds — and a browser has only six connections per host to spend on a whole
// shelf. Measured against the real endpoints: the biggest index (NES, 3.9 MB)
// takes ~3 s and PlayStation ~5 s, so 15 s is triple the slow case — headroom
// for a bad minute, short enough that a dead upstream does not hold the page.
// The two repositories of a dual-console system are fetched in PARALLEL exactly
// so they cannot stack into 30.
const INDEX_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 10_000;
// A boxart is 50-300 KB. Ten megabytes is not a real cover; it is either the
// wrong URL or something trying to make this process eat RAM.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// The GBA index is ~5 900 names; MAME ~6 000. A few megabytes of JSON is the
// honest ceiling, and anything beyond it is not an index.
const MAX_INDEX_BYTES = 48 * 1024 * 1024;

/** @type {Map<string, { fetchedAt: number, entries: Array<{ repo: string, file: string, key: string, tokens: Set<string>, numbers: string }> }>} */
const indexCache = new Map();
/** @type {Map<string, Promise<unknown>>} in-flight dedupe: one shelf load fires ~50 requests at once. */
const inflight = new Map();
/** @type {Map<string, number>} cache key -> expiry of a known miss. */
const misses = new Map();
/** @type {Map<string, number>} system -> the moment its index may be re-fetched. */
const indexRetryAfter = new Map();
/** @type {Map<string, number>} system -> the cooldown we already logged for it. */
const cooldownLogged = new Map();
let rateLimitedUntil = 0;

// ---------------------------------------------------------------------------
// Logging. There is no shared logger to import: server.mjs's `logError` lives
// behind an import that opens a listening socket, which is the whole reason
// games.mjs duplicates it too.
//
// A silent 404 makes "this game has no box art" and "GitHub blocked us for the
// next hour" the same observation, and this repo has been bitten by exactly
// that class of defect before. Every 404 leaves a reason behind.
// ---------------------------------------------------------------------------

function logLine(level, scope, detail) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, scope, ...detail });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

function logError(scope, err, detail) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  logLine('error', scope, { message, ...detail });
}

// ---------------------------------------------------------------------------
// Matching — the part that decides whether the shelf is trustworthy.
// ---------------------------------------------------------------------------

// Roman numerals are folded into digits so "Final Fantasy IV" and "Final
// Fantasy 4" are one game, whichever way each side spelled it. A lone `I` is
// excluded: it is an initial or a stray tag far more often than a sequel.
//
// `V` and `X` are in, despite "V-Rally" and "X-Games", because the fold is
// applied to BOTH sides and therefore cancels out. That is an argument, so it
// was checked rather than believed, on two real indexes: Game Boy Advance
// (14 891 distinct titles) collides ZERO times, and Super Nintendo collides
// exactly twice — "Human Grand Prix II"/"2" and "Magical Drop II"/"2", the same
// game spelled two ways, which is precisely what the fold is FOR. Re-run that
// count before removing an entry from this table, and before adding one.
const ROMAN = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
  xiii: '13',
};

/**
 * "Legend of Zelda, The - The Minish Cap (USA, Australia).gba"
 *   -> "legend of zelda the the minish cap"
 *
 * Both sides of the comparison go through this. Everything it removes is
 * metadata that ROM sets and thumbnail sets disagree about freely: the region,
 * the language list, the revision, the dump flags. Accents go too, because
 * "Pokémon" on one side and "Pokemon" on the other is the same game.
 */
export function normalizeTitle(name) {
  // `\.[A-Za-z0-9]{1,8}$` and NOT `\.[^.]+$`. The lax version strips from the
  // LAST dot, and plenty of titles carry one: "Super Mario Bros. 3" lost its
  // "3" and matched Super Mario Bros 1 exactly. Dr., Mr., R.C. and Vol. all
  // failed the same way. An extension is letters and digits with no space, so
  // spelling that out is what makes a dot inside a title survive.
  const stem = String(name ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return stem
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[[(][^)\]]*[)\]]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(norm) {
  const tokens = [];
  for (const raw of norm.split(' ')) {
    if (!raw) continue;
    tokens.push(ROMAN[raw] ?? raw);
  }
  return tokens;
}

/**
 * Every token that CONTAINS a digit, sorted — two titles must agree on these
 * exactly or they are not the same game.
 *
 * Not "every token that IS a number": measured against the real 5 961-name GBA
 * index, widening this from pure digits to any token carrying one cut wrong
 * matches from 15.8% to 4.9%. The names that made the difference are the ones
 * where the number is welded to a letter — the e-Reader card sets
 * ("Doubutsu no Mori Card-e - Series 1 - 04-A019") differ from each other in
 * nothing else, and a pure-digit rule cheerfully handed all forty of them the
 * cover of card 04-A001.
 */
function numbersOf(tokens) {
  return tokens
    .filter((t) => /\d/.test(t))
    .sort()
    .join(',');
}

/** Everything matching needs from one name, computed once. */
function analyze(name) {
  const tokens = tokenize(normalizeTitle(name));
  // The key is the FOLDED title, so "Final Fantasy IV" and "Final Fantasy 4"
  // are the same string and settle in the exact pass instead of the fuzzy one.
  return { key: tokens.join(' '), tokens: new Set(tokens), numbers: numbersOf(tokens) };
}

/**
 * Pre-compute what matching needs, once per index refresh, instead of once per
 * request per entry — a console has ~6 000 names and a shelf load asks ~50
 * times, so normalizing on the fly would be six figures of string work per
 * page view.
 */
export function prepareEntries(repo, files) {
  const entries = [];
  for (const file of files) {
    if (typeof file !== 'string' || !file) continue;
    entries.push({ repo, file, ...analyze(file) });
  }
  return entries;
}

/**
 * How much of the candidate the ROM's title accounts for, once every one of the
 * ROM's own words is known to appear in it.
 *
 * The asymmetry is the whole trick, and it was measured rather than guessed.
 * Plain token overlap (Jaccard) at the same recall gives 15.8% wrong covers on
 * held-out games; requiring the ROM's words to be a SUBSET of the candidate's
 * gives 1.8% at identical recall. The reason is that the two directions are not
 * equally innocent: a candidate with extra words is usually the same game
 * written out in full ("Pokemon Ruby" -> "Pokemon - Ruby Version"), while a ROM
 * with extra words the candidate lacks is usually a DIFFERENT game that merely
 * contains one ("Animal Crossing - Super Mario Bros." is not Super Mario Bros).
 *
 * What it costs, stated plainly: at 0.6 a two-word ROM name matches a
 * three-word entry that contains it, so a game absent from the index whose
 * spin-off is present ("Monster Rancher" against "Monster Rancher Advance")
 * gets the spin-off's box. Raising the floor to 0.7 removes that and also
 * removes "Pokemon Ruby" -> "Pokemon - Ruby Version", which is the same
 * arithmetic (2/3) and the far more common name. The tie is broken in favour of
 * the case that actually happens in a ROM library.
 *
 * The method, for whoever changes this number: take a console's real index,
 * hold one game out of it, and ask for that game. Anything it answers is a
 * wrong cover. Against the live indexes that is 1.8% on Game Boy Advance
 * (5 961 names) and 1.7% on Super Nintendo (3 704) — and with the game left IN,
 * where it lives in production, 852/852 and 530/530 matched, none of them
 * wrong. If a change makes the first number rise, it is not an improvement
 * however much it helps the second.
 */
const MIN_COVERAGE = 0.6;

/**
 * Pick the box art for one ROM, or null.
 *
 * `entries` come from the index; each carries its repo so the caller can build
 * the CDN URL.
 */
export function pickCover(romName, entries) {
  const q = analyze(romName);
  // A name that was nothing but region tags leaves nothing to match on, and
  // matching on nothing is how every game ends up with the same cover.
  if (!q.key) return null;

  // Pass 1: identical once the tags are gone. This is the overwhelming majority
  // of real hits — "Mega Man Zero (USA).gba" against "Mega Man Zero (USA,
  // Europe).png" is an exact match HERE and a miss on raw filenames. Measured
  // on the real GBA index, every one of an 852-name sample landed here.
  const exact = entries.filter((e) => e.key === q.key);
  if (exact.length) return best(exact);

  // Pass 2: the ROM's words, all of them, inside a longer candidate.
  let bestScore = 0;
  let candidates = [];
  for (const entry of entries) {
    if (entry.numbers !== q.numbers) continue;
    let shared = 0;
    for (const token of q.tokens) if (entry.tokens.has(token)) shared++;
    if (shared !== q.tokens.size) continue; // a word we have and it does not: different game
    const coverage = q.tokens.size / entry.tokens.size;
    if (coverage < MIN_COVERAGE || coverage < bestScore) continue;
    if (coverage > bestScore) {
      bestScore = coverage;
      candidates = [entry];
    } else {
      candidates.push(entry);
    }
  }
  return candidates.length ? best(candidates) : null;
}

/**
 * Break a tie deterministically: shortest name first, then alphabetical.
 *
 * Ties are the NORM here, not the exception — "(USA)", "(USA, Europe)",
 * "(USA) (Rev 1)" and "(USA) (Demo) (Kiosk)" all normalize to the same title
 * and all show the same box. Shortest wins because the extra parentheses are
 * exactly what marks a demo, a kiosk build or a Virtual Console re-release, and
 * the plain release is the one a person recognizes. Alphabetical afterwards so
 * the answer never depends on GitHub's tree order.
 */
function best(candidates) {
  return candidates.reduce((a, b) => {
    if (a.file.length !== b.file.length) return a.file.length < b.file.length ? a : b;
    return a.file < b.file ? a : b;
  });
}

// ---------------------------------------------------------------------------
// The name index, per system.
// ---------------------------------------------------------------------------

function indexPath(system) {
  // `system` is a key of SYSTEM_REPOS, never client input — every caller looks
  // it up in that table first. Sanitized anyway, because "never client input"
  // is a property of the CALLERS, and callers move.
  return join(COVERS_DIR, `index-${system.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function hydrate(raw) {
  const entries = [];
  for (const [repo, files] of Object.entries(raw?.repos ?? {})) {
    if (!Array.isArray(files)) continue;
    // Not `push(...prepared)`: a spread becomes one argument per entry, and
    // the arcade index is tens of thousands of names — enough to blow the
    // call stack on the one console that needs the biggest index.
    for (const entry of prepareEntries(repo, files)) entries.push(entry);
  }
  return { fetchedAt: Number(raw?.fetchedAt) || 0, entries };
}

async function writeAtomic(path, data) {
  // Same shape as music-worker's writes: a partial file must never be visible
  // under the real name. A half-written index would poison the cache for a
  // week, and a half-written PNG is a permanently broken cover.
  await mkdir(COVERS_DIR, { recursive: true });
  const tmp = `${path}.tmp.${randomUUID()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Ask GitHub for the names in one repository's `Named_Boxarts/`.
 *
 * `trees/<branch>:Named_Boxarts` (a subtree) and not `trees/<branch>?recursive=1`:
 * the recursive form also returns Named_Snaps and Named_Titles, which is three
 * times the JSON for names we will never use.
 *
 * @returns {Promise<string[] | null>} null means "ask again later", never throws.
 */
async function fetchRepoNames(repo) {
  for (const branch of ['master', 'main']) {
    const url = `${API_BASE}/repos/libretro-thumbnails/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(`${branch}:Named_Boxarts`)}`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          // api.github.com answers 403 to a request with no User-Agent, and
          // Node's fetch does not send one. Without this line every index
          // fetch fails in production while working under curl.
          'user-agent': 'poisonflix-bff',
        },
        // Rule 1: no outbound request without a ceiling. A hung socket here
        // would hold a request handler open until the client gives up.
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      });
    } catch (err) {
      logError('games.covers.index', err, { repo, branch });
      return null;
    }

    // 403/429 are the rate limit. Everything else is a repo that moved or a
    // GitHub incident; neither is worth retrying inside this request.
    if (res.status === 403 || res.status === 429) {
      await discard(res);
      rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      logLine('error', 'games.covers.index', {
        message: 'rate limited',
        repo,
        remaining: res.headers.get('x-ratelimit-remaining'),
        reset: res.headers.get('x-ratelimit-reset'),
        cooldownMs: RATE_LIMIT_COOLDOWN_MS,
      });
      return null;
    }
    // A 404 on `master` is a repo whose default branch is `main`; that is the
    // only reason the loop has a second iteration.
    if (res.status === 404) {
      await discard(res);
      continue;
    }
    if (!res.ok) {
      await discard(res);
      logLine('error', 'games.covers.index', { message: `http ${res.status}`, repo, branch });
      return null;
    }

    // Only a hint: GitHub answers chunked, so this header is usually absent and
    // `readCapped` below is what actually holds the line.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_INDEX_BYTES) {
      await discard(res);
      logLine('error', 'games.covers.index', { message: 'index too large', repo, declared });
      return null;
    }

    const raw = await readCapped(res, MAX_INDEX_BYTES, 'games.covers.index', { repo, branch });
    if (!raw) return null;
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      logError('games.covers.index', err, { repo, branch });
      return null;
    }
    if (!Array.isArray(body?.tree)) {
      logLine('error', 'games.covers.index', { message: 'no tree in response', repo, branch });
      return null;
    }
    // `truncated` is GitHub telling us the tree was too big to return whole. A
    // partial index is still a useful index — it just means some games miss —
    // so take it and say so rather than throwing the whole console away.
    if (body.truncated) {
      logLine('info', 'games.covers.index', { message: 'tree truncated by github', repo });
    }
    return body.tree
      .filter((e) => e?.type === 'blob' && typeof e.path === 'string' && isImage(e.path))
      .map((e) => e.path);
  }
  logLine('error', 'games.covers.index', { message: 'no Named_Boxarts on master or main', repo });
  return null;
}

/**
 * Let go of a body we are not going to read.
 *
 * Every early return from a fetch leaves an open stream behind, and undici
 * keeps the connection reserved until that body is consumed or cancelled — so
 * a run of failures slowly parks sockets in the pool for nothing. Cancelling is
 * one line and removes the question entirely.
 */
function discard(res) {
  return res.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

/**
 * Read a response body, giving up the moment it passes `max`.
 *
 * `await res.arrayBuffer()` was here, and it is not a cap at all: it buffers
 * EVERYTHING and only then lets the caller measure it. A chunked response
 * carries no Content-Length to pre-check, so a broken CDN pushing 200 MB took
 * this process from 57 MB to 706 MB of RSS before the size check ran — in a
 * container with no memory limit. Reading chunk by chunk means the ceiling is
 * the ceiling.
 *
 * @returns {Promise<Buffer | null>} null = too big, unreadable, or empty.
 */
async function readCapped(res, max, scope, detail) {
  if (!res.body) return null;
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > max) {
        logLine('error', scope, { message: 'response over cap', max, ...detail });
        // Stop the transfer instead of politely draining it.
        await res.body.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
  } catch (err) {
    logError(scope, err, detail);
    return null;
  }
  return total === 0 ? null : Buffer.concat(chunks, total);
}

function isImage(name) {
  return /\.(png|jpe?g)$/i.test(name);
}

function contentTypeOf(name) {
  return /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
}

/**
 * The index for one system: memory, then disk, then GitHub.
 *
 * A refresh that fails KEEPS THE STALE INDEX. Seven-day-old names are still the
 * right names for a library nobody added to today, and dropping them because
 * GitHub had a bad minute would blank the whole shelf (rule 1).
 */
async function loadIndex(system) {
  const repos = SYSTEM_REPOS[system];
  if (!repos) return null;

  const cached = indexCache.get(system);
  if (cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) return cached;

  return await once(`index:${system}`, async () => {
    // Re-read under the in-flight lock: fifty concurrent cover requests for the
    // same console must produce ONE GitHub call, not fifty.
    const fresh = indexCache.get(system);
    if (fresh && Date.now() - fresh.fetchedAt < INDEX_TTL_MS) return fresh;

    let onDisk = fresh ?? null;
    if (!onDisk) {
      const raw = await readFile(indexPath(system), 'utf8').catch(() => null);
      if (raw) {
        try {
          onDisk = hydrate(JSON.parse(raw));
          indexCache.set(system, onDisk);
        } catch (err) {
          // A corrupt cache file is not fatal; it is a file to overwrite.
          logError('games.covers.index', err, { system, cache: indexPath(system) });
        }
      }
    }
    if (onDisk && Date.now() - onDisk.fetchedAt < INDEX_TTL_MS) return onDisk;

    // Stale or absent. Only now is GitHub allowed to be involved — and only if
    // neither the global rate-limit cooldown nor this console's own backoff is
    // still running.
    if (Date.now() < rateLimitedUntil) {
      // Once per console per cooldown, not once per cover: a shelf of 300 games
      // with no index would otherwise put 300 identical lines in the log every
      // time somebody opened it.
      if (!onDisk && cooldownLogged.get(system) !== rateLimitedUntil) {
        cooldownLogged.set(system, rateLimitedUntil);
        logLine('info', 'games.covers.index', { message: 'in rate-limit cooldown', system });
      }
      return onDisk;
    }
    if (Date.now() < (indexRetryAfter.get(system) ?? 0)) return onDisk;

    // In parallel, not one after the other. No system has more than two
    // repositories, so this is two sockets at most — and serially their
    // timeouts would ADD UP on the one request unlucky enough to trigger the
    // refresh, which is the difference between a slow cover and a stalled page.
    // A repository that fails simply contributes nothing to the union.
    const fetched = await Promise.all(repos.map((repo) => fetchRepoNames(repo)));
    const repoFiles = {};
    let gotAny = false;
    repos.forEach((repo, i) => {
      if (fetched[i]) {
        repoFiles[repo] = fetched[i];
        gotAny = true;
      }
    });
    if (!gotAny) {
      // Back off before returning, or the next cover request repeats this.
      indexRetryAfter.set(system, Date.now() + INDEX_RETRY_COOLDOWN_MS);
      return onDisk; // stale beats empty
    }
    indexRetryAfter.delete(system);

    const record = { fetchedAt: Date.now(), repos: repoFiles };
    await writeAtomic(indexPath(system), JSON.stringify(record)).catch((err) => {
      // An unwritable /data means we re-fetch next time — degraded, not broken.
      logError('games.covers.index', err, { system });
    });
    const hydrated = hydrate(record);
    indexCache.set(system, hydrated);
    logLine('info', 'games.covers.index', {
      message: 'refreshed',
      system,
      entries: hydrated.entries.length,
    });
    return hydrated;
  });
}

// ---------------------------------------------------------------------------
// The image.
// ---------------------------------------------------------------------------

/**
 * Cache filename for a ROM id.
 *
 * The id is already base64url, so it is filesystem-safe — but it encodes a path
 * and can run to a thousand characters, and every filesystem here caps a name
 * at 255. Long ids collapse to a hash; short ones stay readable, because being
 * able to tell which file is which while looking at the cache directory is
 * worth something when this misbehaves.
 */
function cacheKey(id) {
  if (/^[A-Za-z0-9_-]{1,120}$/.test(id)) return id;
  return `h-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/** Dedupe concurrent work under one key. */
function once(key, fn) {
  const running = inflight.get(key);
  if (running) return running;
  const started = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, started);
  return started;
}

async function cachedImage(key) {
  for (const ext of ['png', 'jpg']) {
    const path = join(COVERS_DIR, `${key}.${ext}`);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.size > 0) {
      return { path, sizeBytes: info.size, contentType: contentTypeOf(path) };
    }
  }
  return null;
}

async function downloadCover(entry, key) {
  // Each segment encoded separately: the repo name becomes a directory with
  // SPACES in it, and file names carry apostrophes, commas and ampersands.
  const dir = encodeURIComponent(entry.repo.replaceAll('_', ' '));
  const url = `${CDN_BASE}/${dir}/Named_Boxarts/${encodeURIComponent(entry.file)}`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  } catch (err) {
    logError('games.covers.image', err, { repo: entry.repo, file: entry.file });
    return null;
  }
  if (!res.ok) {
    await discard(res);
    // The index says it exists and the CDN disagrees: it lags the repos by a
    // little. Ordinary, hence info.
    logLine('info', 'games.covers.image', {
      message: `http ${res.status}`,
      repo: entry.repo,
      file: entry.file,
    });
    return null;
  }

  // Same as the index: a hint that saves a download when it is present, never
  // the thing being relied on.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await discard(res);
    logLine('error', 'games.covers.image', { message: 'image too large', declared, file: entry.file });
    return null;
  }

  const bytes = await readCapped(res, MAX_IMAGE_BYTES, 'games.covers.image', {
    repo: entry.repo,
    file: entry.file,
  });
  if (!bytes) return null;

  const ext = /\.jpe?g$/i.test(entry.file) ? 'jpg' : 'png';
  const path = join(COVERS_DIR, `${key}.${ext}`);
  try {
    await writeAtomic(path, bytes);
  } catch (err) {
    // Serve it anyway: a cache we cannot write is a slow cover, not a missing
    // one. The next request pays the download again.
    logError('games.covers.cache', err, { path });
    return { bytes, contentType: contentTypeOf(path) };
  }
  return { path, sizeBytes: bytes.length, contentType: contentTypeOf(path) };
}

function remember(key, reason, detail) {
  const known = misses.get(key);
  misses.set(key, Date.now() + MISS_TTL_MS);
  // One line the first time only. A shelf of 300 uncovered games must not put
  // 300 lines in the log on every single page load.
  if (!known || known < Date.now()) logLine('info', 'games.covers.miss', { reason, ...detail });
  // Bounded: this map is keyed by ROM id and a library can be large.
  if (misses.size > 4096) {
    for (const [k, exp] of misses) {
      if (exp < Date.now()) misses.delete(k);
    }
    if (misses.size > 4096) misses.clear();
  }
  return null;
}

/**
 * Box art for one game, from cache or from upstream.
 *
 * @param {{ id: string, system: string, file: string }} game
 *   `file` is the ROM's name ON DISK, extension and tags included. Not a
 *   pre-cleaned title: both sides of the match must go through `normalizeTitle`
 *   and nothing else, or they stop being comparable (games.mjs explains the
 *   "Super Mario Bros. 3" case that proved it).
 * @returns {Promise<null | { path?: string, bytes?: Buffer, sizeBytes?: number, contentType: string }>}
 *   null means "paint the placeholder" — for every reason, since the client can
 *   do nothing differently about a rate limit than about a game with no art.
 *   The REASON goes to the log, where someone can act on it.
 *
 * Never throws. A cover is decoration; nothing it does may reach the router's
 * error path or the ROM stream.
 */
export async function coverFor(game) {
  const key = cacheKey(game.id);

  // Before anything else, including the miss cache: a file on disk is the
  // cheapest and most certain answer there is.
  const hit = await cachedImage(key);
  if (hit) return hit;

  const missUntil = misses.get(key);
  if (missUntil && missUntil > Date.now()) return null;

  const repos = SYSTEM_REPOS[game.system];
  if (!repos) return remember(key, 'unmapped-system', { system: game.system });

  return await once(`cover:${key}`, async () => {
    // The download may have landed while we waited behind the same key.
    const raced = await cachedImage(key);
    if (raced) return raced;

    const index = await loadIndex(game.system);
    if (!index || index.entries.length === 0) {
      return remember(key, 'no-index', { system: game.system, file: game.file, id: game.id });
    }

    const entry = pickCover(game.file, index.entries);
    if (!entry) {
      // `file` and `id`, not a title: two ROMs can share a title, and the log
      // is where someone works out WHICH game has no art.
      return remember(key, 'no-match', { system: game.system, file: game.file, id: game.id });
    }

    const image = await downloadCover(entry, key);
    if (!image) {
      return remember(key, 'download-failed', { system: game.system, file: entry.file });
    }
    return image;
  });
}

/** Test seam: the caches are process-wide and a test needs a clean slate. */
export function resetCoverCaches() {
  indexCache.clear();
  misses.clear();
  inflight.clear();
  indexRetryAfter.clear();
  cooldownLogged.clear();
  rateLimitedUntil = 0;
}
