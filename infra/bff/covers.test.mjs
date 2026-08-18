// Tests for game box art. Node's built-in runner, zero dependencies.
//
//   node --test infra/bff/covers.test.mjs
//
// Two halves:
//
//   1. Matching, against REAL names taken from the libretro GBA thumbnail
//      repository. Matching is the part that can be quietly, confidently wrong
//      — a plausible cover under the wrong game — so the fixtures are the
//      actual strings, tags and all, not a tidied-up version of them.
//   2. The endpoint, driven over real HTTP with GitHub and the CDN replaced by
//      a local server. That fake counts its own requests, which is how the
//      caching claims ("one index fetch per console", "an image is never asked
//      for twice") get asserted instead of assumed.
//
// The env vars are set BEFORE the imports because both modules read them at
// import time, the same trick games.test.mjs uses for GAMES_DIR.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A real, tiny 1x1 PNG. The endpoint must hand back these exact bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Names copied verbatim out of libretro-thumbnails/Nintendo_-_Game_Boy_Advance.
 * Note how many of them collapse to the same title once the tags are stripped:
 * that ambiguity is the normal case, not an edge case.
 */
const GBA_NAMES = [
  'Mega Man Zero (USA) (Virtual Console).png',
  'Mega Man Zero (USA, Europe).png',
  'Mega Man Zero 2 (Europe).png',
  'Mega Man Zero 2 (USA).png',
  'Mega Man Zero 3 (USA).png',
  'Legend of Zelda, The - A Link to the Past _ Four Swords (USA).png',
  'Legend of Zelda, The - The Minish Cap (Europe) (En,Fr,De,Es,It).png',
  'Legend of Zelda, The - The Minish Cap (USA) (Demo) (Kiosk).png',
  'Legend of Zelda, The - The Minish Cap (USA).png',
  'Pokemon - Ruby Version (USA).png',
  'Pokemon - Ruby Version (USA, Europe) (Rev 1).png',
  'Pokemon - Ruby Version (USA, Europe).png',
  'Pokemon - Sapphire Version (USA, Europe).png',
  'Metroid Fusion (USA, Australia).png',
  'Final Fantasy IV Advance (USA).png',
];

let covers; // the module under test
let games; // the router, for the HTTP half
let root; // temp dir holding the ROM fixtures and the cache
let cacheDir;
let baseUrl; // the BFF under test
let bff;
let upstream; // stands in for api.github.com AND thumbnails.libretro.com
let upstreamUrl;

/**
 * A handful of real NES names, for the one bug that only shows up with a dot
 * inside the title (see the "Super Mario Bros. 3" case below).
 */
const NES_NAMES = [
  'Super Mario Bros. (World).png',
  'Super Mario Bros. 3 (USA).png',
  'Dr. Mario (Japan, USA).png',
  // A title whose LAST word is dotted. Strip the tags first, as games.mjs's
  // `titleOf` does, and ".2" becomes the trailing "extension" — which is how
  // this one tells a real fix from a partial one.
  'Puzzle Series Vol.2 (Japan).png',
  'Puzzle Series Vol.1 (Japan).png',
];

/** What the fake upstream was asked for, so the cache can be proven. */
const calls = { index: 0, image: 0, lastImage: '', imageBytesSent: 0 };
/** Flip to make GitHub "fail" the way it fails in production. */
let indexStatus = 200;
let imageStatus = 200;
/** Megabytes of garbage the fake CDN pushes instead of a cover. */
let imageFlood = 0;
/** Whether the flood announces its size up front (Content-Length) or not. */
let imageDeclaresLength = false;

function idOf(relPath) {
  return Buffer.from(relPath, 'utf8').toString('base64url');
}

before(async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'covers-test-'));
  root = await realpath(tmp); // macOS puts /tmp behind a symlink; games.mjs compares realpaths
  const gamesDir = join(root, 'games');
  cacheDir = join(root, 'cache');
  await mkdir(join(gamesDir, 'gba'), { recursive: true });
  await mkdir(join(gamesDir, 'atari2600'), { recursive: true });
  await writeFile(join(gamesDir, 'gba', 'Pokemon - Ruby Version (USA).gba'), 'rom');
  await writeFile(join(gamesDir, 'gba', 'Mega Man Zero (USA).gba'), 'rom');
  await writeFile(join(gamesDir, 'gba', 'Homebrew Thing 9000 (PD).gba'), 'rom');
  await writeFile(join(gamesDir, 'atari2600', 'Nothing At All (Unl).a26'), 'rom');
  // Real ROM libraries are full of dotted titles, and they are the one shape
  // that the endpoint got wrong end to end — see the test below.
  await mkdir(join(gamesDir, 'nes'), { recursive: true });
  await writeFile(join(gamesDir, 'nes', 'Super Mario Bros. 3 (USA).nes'), 'rom');
  await writeFile(join(gamesDir, 'nes', 'Puzzle Series Vol.2 (Japan).nes'), 'rom');

  // The fake GitHub + CDN. One server for both, because the module reaches them
  // through two independent base URLs and nothing else distinguishes them.
  upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream');
    if (url.pathname.includes('/git/trees/')) {
      calls.index++;
      if (indexStatus !== 200) {
        res.writeHead(indexStatus, {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        });
        return res.end('{}');
      }
      // Per-repository, so a test can prove a console reads ITS OWN index.
      const names = url.pathname.includes('Entertainment_System') ? NES_NAMES : GBA_NAMES;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          truncated: false,
          tree: names.map((path) => ({ path, type: 'blob' })),
        }),
      );
    }
    if (url.pathname.includes('/Named_Boxarts/')) {
      calls.image++;
      calls.lastImage = decodeURIComponent(url.pathname).split('/Named_Boxarts/')[1] ?? '';
      if (imageStatus !== 200) {
        res.writeHead(imageStatus);
        return res.end();
      }
      if (imageFlood > 0) {
        const size = imageFlood * 1024 * 1024;
        // With a Content-Length the cap can refuse before reading a byte;
        // without one (chunked) only the streaming cap can save us. Both shapes
        // are real and both are tested.
        res.writeHead(200, {
          'content-type': 'image/png',
          ...(imageDeclaresLength ? { 'content-length': String(size) } : {}),
        });
        const mb = Buffer.alloc(1024 * 1024, 0x41);
        let sent = 0;
        const push = () => {
          while (sent < imageFlood) {
            sent++;
            calls.imageBytesSent += mb.length;
            if (!res.write(mb)) return res.once('drain', push);
          }
          res.end();
        };
        res.on('error', () => {}); // the client is SUPPOSED to hang up on us
        return push();
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  process.env.GAMES_DIR = gamesDir;
  process.env.GAMES_COVERS_DIR = cacheDir;
  process.env.GAMES_COVERS_API = upstreamUrl;
  process.env.GAMES_COVERS_CDN = upstreamUrl;
  covers = await import('./covers.mjs');
  games = await import('./games.mjs');

  bff = createServer((req, res) => {
    const url = new URL(req.url, 'http://bff');
    void games.handleGames(req, res, url.pathname.slice('/bff/games'.length), url.search);
  });
  await new Promise((done) => bff.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${bff.address().port}`;
});

after(async () => {
  await new Promise((done) => bff.close(done));
  await new Promise((done) => upstream.close(done));
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  calls.index = 0;
  calls.image = 0;
  calls.lastImage = '';
  calls.imageBytesSent = 0;
  indexStatus = 200;
  imageStatus = 200;
  imageFlood = 0;
  imageDeclaresLength = false;
  covers.resetCoverCaches();
  await rm(cacheDir, { recursive: true, force: true });
});

describe('normalizeTitle', () => {
  test('strips everything a ROM set and a thumbnail set disagree about', () => {
    const { normalizeTitle } = covers;
    assert.equal(normalizeTitle('Pokemon - Ruby Version (USA).gba'), 'pokemon ruby version');
    assert.equal(
      normalizeTitle('Legend of Zelda, The - The Minish Cap (USA, Australia).gba'),
      'legend of zelda the the minish cap',
    );
    assert.equal(normalizeTitle('Super_Mario_Bros_3_(USA)_[!].nes'), 'super mario bros 3');
    assert.equal(normalizeTitle('Metroid Fusion (U) [!].gba'), 'metroid fusion');
    // Accents: the same game, written two ways.
    assert.equal(normalizeTitle('Pokémon Rojo.gba'), normalizeTitle('Pokemon Rojo.gba'));
    // A name that is nothing but tags leaves nothing to match on, and matching
    // on nothing is how every game gets the same cover.
    assert.equal(normalizeTitle('(USA) [!].gba'), '');
  });
});

describe('pickCover', () => {
  const entries = () => covers.prepareEntries('Nintendo_-_Game_Boy_Advance', GBA_NAMES);

  test('an exact title match wins, ignoring region and revision tags', () => {
    const hit = covers.pickCover('Pokemon - Ruby Version (USA).gba', entries());
    assert.equal(hit.file, 'Pokemon - Ruby Version (USA).png');
  });

  test('a tie between region variants resolves to the plainest release', () => {
    // Three entries normalize to this exact title; the (Demo) (Kiosk) one and
    // the (Europe) (En,Fr,...) one must not win.
    const hit = covers.pickCover(
      'Legend of Zelda, The - The Minish Cap (USA, Australia).gba',
      entries(),
    );
    assert.equal(hit.file, 'Legend of Zelda, The - The Minish Cap (USA).png');
  });

  test('a Virtual Console re-release never beats the plain release', () => {
    // The two candidates are "(USA) (Virtual Console)" and "(USA, Europe)":
    // the raw filenames differ from the ROM's, and only normalization ties them.
    const hit = covers.pickCover('Mega Man Zero (USA).gba', entries());
    assert.equal(hit.file, 'Mega Man Zero (USA, Europe).png');
  });

  test('a sequel number is never fuzzed away', () => {
    // "Mega Man Zero" and "Mega Man Zero 2" share three of four tokens, which
    // clears any similarity floor worth having. Numbers are compared exactly,
    // so each finds itself and nothing else.
    // Two regions tie on the title; the shorter filename breaks it.
    assert.equal(covers.pickCover('Mega Man Zero 2 (Japan).gba', entries()).file, 'Mega Man Zero 2 (USA).png');
    assert.equal(covers.pickCover('Mega Man Zero 3 (Europe).gba', entries()).file, 'Mega Man Zero 3 (USA).png');
    // ...and a fourth game that is not in the index gets nothing, rather than
    // being handed the cover of Zero 3.
    assert.equal(covers.pickCover('Mega Man Zero 4 (USA).gba', entries()), null);
  });

  test('a shortened name still finds its game', () => {
    // "Pokemon Ruby" against "Pokemon - Ruby Version": two tokens of three.
    const hit = covers.pickCover('Pokemon Ruby (USA).gba', entries());
    assert.equal(hit.file, 'Pokemon - Ruby Version (USA).png');
  });

  test('roman numerals and digits are the same number', () => {
    assert.equal(
      covers.pickCover('Final Fantasy 4 Advance (USA).gba', entries()).file,
      'Final Fantasy IV Advance (USA).png',
    );
  });

  test('a ROM whose name CONTAINS another game does not steal its cover', () => {
    // The asymmetry that does most of the work: extra words on the CANDIDATE
    // side are usually the same game spelled out ("Pokemon Ruby" ->
    // "Pokemon - Ruby Version"), extra words on the ROM side are usually a
    // different game that merely contains one. Measured on the real GBA index,
    // this single rule takes wrong covers from 15.8% down to 1.8%.
    const withMetroid = covers.prepareEntries('R', [...GBA_NAMES, 'Metroid Fusion (USA, Australia).png']);
    assert.equal(covers.pickCover('Animal Crossing - Metroid Fusion (USA).gba', withMetroid), null);
    assert.equal(covers.pickCover('Pokemon - Ruby Version Randomizer Nuzlocke.gba', entries()), null);
  });

  test('a number welded to a letter still has to match exactly', () => {
    // The e-Reader card sets differ in nothing but this. A rule that only
    // compared standalone numbers handed all forty of them the same cover.
    const cards = covers.prepareEntries('R', [
      'Doubutsu no Mori Card-e - Series 1 - 04-A001 (Japan).png',
      'Doubutsu no Mori Card-e - Series 1 - 04-A019 (Japan).png',
    ]);
    assert.equal(
      covers.pickCover('Doubutsu no Mori Card-e - Series 1 - 04-A019 (Japan).gba', cards).file,
      'Doubutsu no Mori Card-e - Series 1 - 04-A019 (Japan).png',
    );
    assert.equal(covers.pickCover('Doubutsu no Mori Card-e - Series 1 - 04-A077 (Japan).gba', cards), null);
  });

  test('a dot inside the title is not an extension', () => {
    // The bug this test exists for: `\.[^.]+$` strips from the LAST dot, so
    // "Super Mario Bros. 3" became "Super Mario Bros" and matched Super Mario
    // Bros 1 EXACTLY — pass 1, never reaching the number check. Every ROM
    // library on earth has these names, and an immutable week-long cache meant
    // each wrong cover stuck.
    const nes = covers.prepareEntries('N', [
      'Super Mario Bros. (World).png',
      'Super Mario Bros. 3 (USA).png',
      'Dr. Mario (Japan, USA).png',
      'Mr. Do! (USA).png',
    ]);
    assert.equal(covers.pickCover('Super Mario Bros. 3 (USA).nes', nes).file, 'Super Mario Bros. 3 (USA).png');
    assert.equal(covers.pickCover('Super Mario Bros. (World).nes', nes).file, 'Super Mario Bros. (World).png');
    assert.equal(covers.pickCover('Dr. Mario (USA).nes', nes).file, 'Dr. Mario (Japan, USA).png');
    assert.equal(covers.pickCover('Mr. Do! (USA).nes', nes).file, 'Mr. Do! (USA).png');
    // Super Mario Bros. 2 is absent from this index: a placeholder, not book 1.
    assert.equal(covers.pickCover('Super Mario Bros. 2 (USA).nes', nes), null);
    // And the normalization keeps the number that used to vanish.
    assert.equal(covers.normalizeTitle('Super Mario Bros. 3'), 'super mario bros 3');
    assert.equal(covers.normalizeTitle('Super Mario Bros. 3 (USA).nes'), 'super mario bros 3');
  });

  test('a game nobody has art for gets NOTHING, not the nearest thing', () => {
    // The whole point: a wrong cover is worse than a placeholder.
    for (const name of [
      'Homebrew Thing 9000 (PD).gba',
      'Some Random Demo (Unl).gba',
      '(USA) [!].gba', // nothing left after normalization
      'Pokemon - Emerald Version (USA).gba', // a real game, absent from this index
    ]) {
      assert.equal(covers.pickCover(name, entries()), null, `matched something for ${name}`);
    }
  });
});

describe('GET /bff/games/cover', () => {
  const rubyId = () => idOf('gba/Pokemon - Ruby Version (USA).gba');

  test('serves the image with an immutable, week-long cache header', async () => {
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${rubyId()}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=604800, immutable');
    assert.equal(res.headers.get('content-length'), String(PNG.length));
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  test('a missing or malformed id is a 404, not a crash', async () => {
    for (const query of ['', '?id=', '?id=not%20base64%21', `?id=${idOf('gba/ghost.gba')}`]) {
      const res = await fetch(`${baseUrl}/bff/games/cover${query}`);
      assert.equal(res.status, 404, `unexpected status for ${JSON.stringify(query)}`);
    }
    // A traversal id must die in resolveRom, exactly as it does for /rom.
    const escape = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('../../etc/passwd')}`);
    assert.equal(escape.status, 404);
  });

  test('a game with no match answers 404 without asking the CDN for anything', async () => {
    const res = await fetch(
      `${baseUrl}/bff/games/cover?id=${idOf('gba/Homebrew Thing 9000 (PD).gba')}`,
    );
    assert.equal(res.status, 404);
    assert.equal(calls.image, 0, 'the CDN was asked for a cover we had no name for');
  });

  test('a console indexes on its own, and a miss there costs no image', async () => {
    // This asked for a file that did not EXIST, so resolveRom answered 404 and
    // covers.mjs never ran — the assertion was true for the wrong reason. The
    // ROM is real now, so the request reaches the index, misses, and stops.
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('atari2600/Nothing At All (Unl).a26')}`);
    assert.equal(res.status, 404);
    // Its own console's index, fetched once; no image asked for on a miss.
    assert.equal(calls.index, 1);
    assert.equal(calls.image, 0);
    // And the 404 is cacheable, or a shelf with no art re-asks on every visit.
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });

  test('a dotted title reaches the matcher intact, end to end', async () => {
    // A unit test on pickCover cannot catch this one: the defect was in the
    // HANDOFF. games.mjs used to pass `title`, which had already had its
    // extension stripped, so the matcher stripped a second time and turned
    // "Super Mario Bros. 3" into "Super Mario Bros" — a request that answered
    // 200 with Super Mario Bros 1's box, cached immutable for a week.
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('nes/Super Mario Bros. 3 (USA).nes')}`);
    assert.equal(res.status, 200);
    assert.equal(
      calls.lastImage,
      'Super Mario Bros. 3 (USA).png',
      'the wrong box art was fetched for Super Mario Bros. 3',
    );

    // And the case that separates the two halves of the fix. Guarding the
    // extension pattern alone is not enough: strip the tags FIRST, the way a
    // display title does, and "Vol.2" ends the string, so ".2" looks exactly
    // like an extension and volume 2 quietly becomes volume 1. Only handing the
    // matcher the untouched filename closes it.
    const vol = await fetch(
      `${baseUrl}/bff/games/cover?id=${idOf('nes/Puzzle Series Vol.2 (Japan).nes')}`,
    );
    assert.equal(vol.status, 200);
    assert.equal(
      calls.lastImage,
      'Puzzle Series Vol.2 (Japan).png',
      'a pre-cleaned title reached the matcher and lost its volume number',
    );
  });

  test('HEAD answers like GET with no body', async () => {
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${rubyId()}`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(PNG.length));
    assert.equal(await res.text(), '');
  });
});

describe('caching', () => {
  test('a whole shelf loading at once costs ONE index fetch', async () => {
    // Without the in-flight dedupe this is one GitHub request per cover, and
    // unauthenticated GitHub allows sixty per hour for the entire household.
    const ids = [
      idOf('gba/Pokemon - Ruby Version (USA).gba'),
      idOf('gba/Mega Man Zero (USA).gba'),
      idOf('gba/Homebrew Thing 9000 (PD).gba'),
    ];
    const results = await Promise.all(
      ids.flatMap((id) => [1, 2, 3].map(() => fetch(`${baseUrl}/bff/games/cover?id=${id}`))),
    );
    await Promise.all(results.map((r) => r.arrayBuffer()));
    assert.equal(calls.index, 1, `index fetched ${calls.index} times`);
    // Two of the three games match; each image is downloaded once despite three
    // concurrent requests for it.
    assert.equal(calls.image, 2, `image fetched ${calls.image} times`);
  });

  test('the index survives a restart on disk, and the image is never re-downloaded', async () => {
    const first = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    assert.equal(calls.index, 1);
    assert.equal(calls.image, 1);

    // The cache lives in /data, NOT in the read-only ROM mount.
    const files = await readdir(cacheDir);
    assert.ok(files.includes('index-gba.json'), `no index in the cache: ${files}`);
    const index = JSON.parse(await readFile(join(cacheDir, 'index-gba.json'), 'utf8'));
    assert.ok(index.fetchedAt > 0, 'the index has no timestamp, so it can never expire');
    assert.equal(index.repos['Nintendo_-_Game_Boy_Advance'].length, GBA_NAMES.length);
    // No leftover .tmp: writes are atomic, and a visible partial file would
    // poison the cache for a week.
    assert.equal(files.filter((f) => f.includes('.tmp')).length, 0, `partial writes left behind: ${files}`);

    // Drop every in-memory cache — this is what a container restart looks like.
    covers.resetCoverCaches();
    const second = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(second.status, 200);
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), PNG);
    assert.equal(calls.index, 1, 'the on-disk index was re-fetched from GitHub');
    assert.equal(calls.image, 1, 'a cached image was downloaded again');
  });

  test('a game with no cover is not re-matched against the CDN on every visit', async () => {
    const id = idOf('gba/Homebrew Thing 9000 (PD).gba');
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/bff/games/cover?id=${id}`);
      assert.equal(res.status, 404);
    }
    assert.equal(calls.image, 0);
    assert.equal(calls.index, 1);
  });
});

describe('upstream failures never reach the client as anything but 404', () => {
  test('GitHub rate-limiting the index answers 404 and then stops asking', async () => {
    indexStatus = 403;
    const first = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(first.status, 404);
    assert.deepEqual(await first.json(), { error: 'not found' });

    // The cooldown is the point: retrying inside the rate-limit window is how a
    // shelf of 300 games keeps the whole household blocked for the full hour.
    const second = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Pokemon - Ruby Version (USA).gba')}`);
    assert.equal(second.status, 404);
    assert.equal(calls.index, 1, `GitHub was asked ${calls.index} times while rate-limited`);
  });

  test('a GitHub outage is not re-asked once per cover', async () => {
    // The rate limit has its own cooldown; this is every OTHER failure. Without
    // a per-console backoff, one shelf load against a broken repo spends the
    // entire hourly allowance — and there is no cache to fall back on, because
    // the failure is what stopped one from existing.
    indexStatus = 500;
    for (const rom of [
      'gba/Mega Man Zero (USA).gba',
      'gba/Pokemon - Ruby Version (USA).gba',
      'gba/Homebrew Thing 9000 (PD).gba',
    ]) {
      const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf(rom)}`);
      assert.equal(res.status, 404);
    }
    // One call, not three. (A 500 does not even try `main`: only a 404 means
    // "wrong branch name" — everything else is GitHub having a bad day.)
    assert.equal(calls.index, 1, `GitHub was asked ${calls.index} times after failing`);
  });

  test('a stale index keeps working when GitHub is down', async () => {
    // Warm the cache, then take GitHub away and forget everything in memory.
    await (await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`)).arrayBuffer();
    indexStatus = 500;
    covers.resetCoverCaches();

    // EXPIRE it. Without this the on-disk index is a minute old, loadIndex
    // returns it before GitHub is ever consulted, and the outage this test
    // claims to survive is never actually applied — the assertion passed on a
    // code path that has nothing to do with the name of the test.
    const file = join(cacheDir, 'index-gba.json');
    const stale = JSON.parse(await readFile(file, 'utf8'));
    stale.fetchedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await writeFile(file, JSON.stringify(stale));

    // A DIFFERENT game, so the answer cannot come from the image cache: it has
    // to come from the index that is already on disk.
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Pokemon - Ruby Version (USA).gba')}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    // Two: the warm-up, then the refresh that GitHub answered with a 500. If
    // this ever reads 1, the index did not expire and the test proves nothing.
    assert.equal(calls.index, 2, 'the expired index was never re-fetched, so the outage was never applied');
  });

  test('the CDN failing on the image is a 404, not a 500', async () => {
    imageStatus = 503;
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
    // And nothing half-written was left in the cache to be served later.
    const files = await readdir(cacheDir).catch(() => []);
    assert.equal(files.filter((f) => f.endsWith('.png')).length, 0, `wrote a broken cover: ${files}`);
  });

  test('a CDN pushing gigabytes is cut off, not buffered', async () => {
    // `await res.arrayBuffer()` used to sit here, so the 10 MB ceiling was
    // measured only AFTER the whole body was in memory: a chunked response
    // carries no Content-Length to pre-check, and 200 MB of it took this
    // process from 57 MB to 706 MB of RSS — in a container with no memory
    // limit. The cap has to apply while reading, not after.
    imageFlood = 64; // MB, chunked
    const before = process.memoryUsage().rss;
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(res.status, 404);
    const grew = (process.memoryUsage().rss - before) / (1024 * 1024);
    assert.ok(grew < 40, `held ${grew.toFixed(0)} MB of a 64 MB flood in memory`);
    // Nothing that big was written to the cache either.
    const files = await readdir(cacheDir).catch(() => []);
    assert.equal(files.filter((f) => f.endsWith('.png')).length, 0, `wrote the flood to disk: ${files}`);
  });

  test('an image that announces an absurd size is refused before it is read', async () => {
    // The cheap half of the same protection: when the CDN does send a
    // Content-Length, there is no reason to read the body at all. Asserting on
    // what the SERVER managed to send is what tells "refused on the headers"
    // apart from "read it all and then complained".
    imageFlood = 12; // MB, over the 10 MB ceiling
    imageDeclaresLength = true;
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(res.status, 404);
    const sent = calls.imageBytesSent / (1024 * 1024);
    assert.ok(sent < 4, `the CDN got to push ${sent.toFixed(0)} MB before we hung up`);
  });

  test('a corrupt index file on disk is replaced, not fatal', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'index-gba.json'), '{ this is not json');
    const res = await fetch(`${baseUrl}/bff/games/cover?id=${idOf('gba/Mega Man Zero (USA).gba')}`);
    assert.equal(res.status, 200);
    assert.equal(calls.index, 1);
  });
});

describe('the system table cannot drift away from SYSTEMS', () => {
  test('every console the shelf can list has a thumbnail repository decision', async () => {
    // A new console added to games.mjs and forgotten here would show a shelf of
    // placeholders with no error anywhere — the exact silent degradation this
    // repo keeps re-learning. Absence must be a DECISION, so it is spelled out
    // in KNOWN_UNMAPPED rather than being the default.
    const source = await readFile(new URL('./games.mjs', import.meta.url), 'utf8');
    const listed = source
      .match(/const SYSTEMS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
      .match(/'([^']+)'/g)
      .map((s) => s.replaceAll("'", ''));
    assert.ok(listed?.length, 'SYSTEMS not found — re-check this test');

    const KNOWN_UNMAPPED = []; // every verified repo is mapped today
    const missing = listed.filter(
      (s) => !(s in covers.SYSTEM_REPOS) && !KNOWN_UNMAPPED.includes(s),
    );
    assert.deepEqual(missing, [], `these systems would silently show no covers: ${missing}`);
  });
});
