// Tests for the "modo gamer" library and ROM server. Node's built-in runner,
// because this service has zero runtime dependencies and adding one to test it
// would be a strange thing to do to it.
//
//   node --test infra/bff/games.test.mjs
//
// GAMES_DIR is redirected to a fixture directory BEFORE importing the module,
// since it reads the env var at import time (same trick jam.test.mjs uses for
// JAM_FILE).
//
// The HTTP cases go through a real server calling the real handler rather than
// asserting on a fake `res`: Range handling only means something on the wire,
// and a hand-rolled double would be the one place a status code or a
// Content-Range could be wrong without a test noticing.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root; // realpath'd temp dir holding everything below
let dir; // the fixture library == GAMES_DIR
let outside; // a directory the library must never reach into
let games; // the module under test
let baseUrl; // http://127.0.0.1:<port>
let server;

/** The ROM whose bytes the Range tests slice up. */
const ROM_BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');

function idOf(relPath) {
  return Buffer.from(relPath, 'utf8').toString('base64url');
}

before(async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'games-test-'));
  // realpath: macOS puts /tmp behind a symlink, and the module compares
  // realpaths. Without this the fixture would look like an escape attempt.
  root = await realpath(tmp);
  dir = join(root, 'games');
  outside = join(root, 'outside');

  await mkdir(join(dir, 'nes'), { recursive: true });
  await mkdir(join(dir, 'snes'), { recursive: true });
  await mkdir(join(dir, 'bios'), { recursive: true }); // not a system -> ignored
  await mkdir(outside, { recursive: true });

  await mkdir(join(dir, 'segaMD'), { recursive: true });
  await writeFile(join(dir, 'nes', 'Super_Mario_Bros_3_(USA)_[!].nes'), ROM_BYTES);
  // `.md` IS the Mega Drive extension. It was on the ignore list as
  // "markdown", which hid every segaMD ROM while segaMD sat in SYSTEMS looking
  // supported. Nothing in the suite could see it, because the fixtures only
  // ever exercised the ignore list with .srm and .jpg.
  await writeFile(join(dir, 'segaMD', 'Sonic 2 (World).md'), 'megadrive-rom');
  await writeFile(join(dir, 'snes', 'Chrono-Trigger (USA).sfc'), 'snes-rom');
  await writeFile(join(dir, 'snes', 'Chrono-Trigger (USA).srm'), 'a save, not a game');
  await writeFile(join(dir, 'snes', 'cover.jpg'), 'box art, not a game');
  await writeFile(join(dir, 'bios', 'scph1001.bin'), 'not in a system folder');
  await writeFile(join(outside, 'secrets.txt'), 'PASSWORDS');
  await symlink(join(outside, 'secrets.txt'), join(dir, 'nes', 'escape.nes'));

  process.env.GAMES_DIR = dir;
  games = await import('./games.mjs');

  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://bff');
    void games.handleGames(req, res, url.pathname.slice('/bff/games'.length), url.search);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
});

describe('GET /bff/games/library', () => {
  test('lists one entry per ROM, with a readable title and a real size', async () => {
    const res = await fetch(`${baseUrl}/bff/games/library`);
    assert.equal(res.status, 200);
    const { games: list } = await res.json();

    assert.deepEqual(
      list.map((g) => [g.system, g.title, g.sizeBytes]),
      [
        ['nes', 'Super Mario Bros 3', ROM_BYTES.length],
        ['segaMD', 'Sonic 2', 'megadrive-rom'.length],
        ['snes', 'Chrono Trigger', 'snes-rom'.length],
      ],
    );
    // The id is the base64url of the relative path, and it round-trips.
    assert.equal(list[0].id, idOf('nes/Super_Mario_Bros_3_(USA)_[!].nes'));
  });

  test('ignores folders that are not systems, companion junk, and escapes', async () => {
    const res = await fetch(`${baseUrl}/bff/games/library`);
    const { games: list } = await res.json();
    const titles = list.map((g) => g.title);

    assert.ok(!list.some((g) => g.system === 'bios'), 'bios/ is not an EmulatorJS system');
    assert.ok(!titles.includes('cover'), 'box art is not a game');
    assert.ok(!titles.some((t) => t.includes('escape')), 'a symlink out of the library is not a game');
    // The .srm sits beside a real ROM with the same stem — dropping it must not
    // drop the game itself.
    assert.equal(list.filter((g) => g.title === 'Chrono Trigger').length, 1);
  });
});

describe('GET /bff/games/rom — security', () => {
  test('an encoded ../../ cannot climb out of the library', async () => {
    for (const attempt of [
      '../outside/secrets.txt',
      '../../etc/passwd',
      'nes/../../outside/secrets.txt',
      '/etc/passwd',
      'nes/..',
    ]) {
      const res = await fetch(`${baseUrl}/bff/games/rom?id=${idOf(attempt)}`);
      assert.equal(res.status, 404, `traversal accepted: ${attempt}`);
      assert.ok(!(await res.text()).includes('PASSWORDS'));
    }
  });

  test('a symlink pointing outside the library is refused', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${idOf('nes/escape.nes')}`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('PASSWORDS'));
  });

  test('a file whose first segment is not a known system is refused', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${idOf('bios/scph1001.bin')}`);
    assert.equal(res.status, 404);
    // Casing is not cosmetic: EmulatorJS's core is `segaMD`, so `segamd` is
    // as unknown as `bios`.
    const wrongCase = await fetch(`${baseUrl}/bff/games/rom?id=${idOf('NES/Super_Mario_Bros_3_(USA)_[!].nes')}`);
    assert.equal(wrongCase.status, 404);
  });

  test('ids that are not exactly what encodeId would produce are refused', async () => {
    for (const id of [
      '',
      'not base64!',
      'bmVzL2E=', // padded: canonical base64url has no '='
      `${idOf('nes/x.nes')}\n`,
      'x'.repeat(2000),
    ]) {
      const res = await fetch(`${baseUrl}/bff/games/rom?id=${encodeURIComponent(id)}`);
      assert.equal(res.status, 404, `malformed id accepted: ${JSON.stringify(id)}`);
    }
  });
});

describe('GET /bff/games/rom — serving', () => {
  const romId = () => idOf('nes/Super_Mario_Bros_3_(USA)_[!].nes');

  test('unknown id answers 404', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${idOf('nes/Nothing Here.nes')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });

  test('a missing id answers 404', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom`);
    assert.equal(res.status, 404);
  });

  test('a whole-file GET returns the bytes and advertises Range support', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${romId()}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-length'), String(ROM_BYTES.length));
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), ROM_BYTES.toString());
  });

  test('a Range request answers 206 with exactly the bytes asked for', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${romId()}`, {
      headers: { range: 'bytes=5-9' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 5-9/${ROM_BYTES.length}`);
    assert.equal(res.headers.get('content-length'), '5');
    assert.equal(await res.text(), '56789');
  });

  test('an open-ended and a suffix Range both work', async () => {
    const open = await fetch(`${baseUrl}/bff/games/rom?id=${romId()}`, {
      headers: { range: 'bytes=30-' },
    });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get('content-range'), `bytes 30-35/${ROM_BYTES.length}`);
    assert.equal(await open.text(), 'uvwxyz');

    const suffix = await fetch(`${baseUrl}/bff/games/rom?id=${romId()}`, {
      headers: { range: 'bytes=-4' },
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), `bytes 32-35/${ROM_BYTES.length}`);
    assert.equal(await suffix.text(), 'wxyz');
  });

  test('a Range past the end answers 416, not a truncated 206', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${romId()}`, {
      headers: { range: `bytes=${ROM_BYTES.length}-` },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${ROM_BYTES.length}`);
  });
});

describe('extensions the ignore list must not swallow', () => {
  // A denylist of extensions is a loaded gun pointed at the SYSTEMS list: any
  // entry that happens to be a real ROM extension hides a whole console, and
  // it fails by omission, so nothing goes red. Assert the two lists cannot
  // contradict each other again.
  test('no ignored extension collides with a real ROM format', async () => {
    const source = await readFile(new URL('./games.mjs', import.meta.url), 'utf8');
    const ignored = source
      .match(/const IGNORED_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
      .match(/'([^']+)'/g)
      .map((s) => s.replaceAll("'", ''));
    assert.ok(ignored?.length, 'IGNORED_EXTENSIONS not found — re-check this test');

    // Extensions that ARE the canonical format for a system in SYSTEMS.
    const romExtensions = [
      '.md', // segaMD — Mega Drive / Genesis
      '.nes',
      '.sfc',
      '.smc', // snes
      '.gb',
      '.gbc',
      '.gba',
      '.n64',
      '.z64',
      '.v64',
      '.nds',
      '.cue',
      '.bin',
      '.iso',
      '.chd', // psx / segaCD / saturn / 3do
      '.gg',
      '.sms',
      '.32x',
      '.a26',
      '.a78',
      '.lnx',
      '.j64',
      '.vb',
      '.pce',
      '.ngp',
      '.ws',
      '.wsc',
      '.zip', // arcade
      '.col',
      '.d64',
      '.t64',
      '.crt', // coleco / c64
    ];
    const collisions = romExtensions.filter((e) => ignored.includes(e));
    assert.deepEqual(collisions, [], `these ROM extensions are being hidden: ${collisions}`);
  });

  test('a Mega Drive .md ROM is listed and served', async () => {
    const id = idOf('segaMD/Sonic 2 (World).md');
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${id}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'megadrive-rom');
  });
});

describe('HEAD', () => {
  test('answers like GET with no body, so a client can size a ROM first', async () => {
    const id = idOf('nes/Super_Mario_Bros_3_(USA)_[!].nes');
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${id}`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(ROM_BYTES.length));
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), '');
  });

  test('still 404s for an unknown id rather than claiming it exists', async () => {
    const res = await fetch(`${baseUrl}/bff/games/rom?id=${idOf('nes/ghost.nes')}`, {
      method: 'HEAD',
    });
    assert.equal(res.status, 404);
  });
});

describe('parseRange', () => {
  test('maps every shape to the right answer', () => {
    const size = 100;
    assert.equal(games.parseRange(undefined, size), null);
    assert.equal(games.parseRange('', size), null);
    // Multi-range and garbage fall back to "send the whole thing", which is
    // always a legal answer.
    assert.equal(games.parseRange('bytes=0-9,20-29', size), null);
    assert.equal(games.parseRange('items=0-9', size), null);
    assert.equal(games.parseRange('bytes=-', size), null);

    // Shapes a strict regex used to reject into a whole-file 200. On a 600 MB
    // PS1 image that is not a harmless fallback, so they must parse: RFC 7230
    // makes the unit token case-insensitive and permits optional whitespace,
    // and leading zeroes are legal digits.
    assert.deepEqual(games.parseRange('BYTES=0-9', size), { start: 0, end: 9 });
    assert.deepEqual(games.parseRange('bytes = 0-9', size), { start: 0, end: 9 });
    assert.deepEqual(games.parseRange(' bytes=0 - 9 ', size), { start: 0, end: 9 });
    assert.deepEqual(games.parseRange('bytes=0000000000000000005-9', size), { start: 5, end: 9 });
    // Absurdly large values stay decidable rather than turning into NaN.
    assert.equal(games.parseRange(`bytes=${'9'.repeat(30)}-`, size), 'unsatisfiable');
    assert.deepEqual(games.parseRange(`bytes=0-${'9'.repeat(30)}`, size), { start: 0, end: 99 });

    assert.deepEqual(games.parseRange('bytes=0-0', size), { start: 0, end: 0 });
    assert.deepEqual(games.parseRange('bytes=10-', size), { start: 10, end: 99 });
    // An end past EOF is clamped, not refused — that is what a browser probing
    // a large file sends.
    assert.deepEqual(games.parseRange('bytes=90-999', size), { start: 90, end: 99 });
    assert.deepEqual(games.parseRange('bytes=-10', size), { start: 90, end: 99 });
    // A suffix longer than the file is the whole file.
    assert.deepEqual(games.parseRange('bytes=-500', size), { start: 0, end: 99 });

    assert.equal(games.parseRange('bytes=100-', size), 'unsatisfiable');
    assert.equal(games.parseRange('bytes=50-40', size), 'unsatisfiable');
    assert.equal(games.parseRange('bytes=-0', size), 'unsatisfiable');
    assert.equal(games.parseRange('bytes=0-', 0), 'unsatisfiable');
  });
});

describe('the session gate in server.mjs', () => {
  // This suite mounts handleGames bare, with no auth in front of it — which is
  // exactly what the real router does NOT do. Nothing else here would notice
  // if someone moved the /bff/games dispatch above the 401, and the whole
  // library would silently become world-readable to anyone who can reach the
  // proxy. Booting server.mjs to test it for real is not an option (it listens
  // at import and calls Jellyseerr), so assert on the one thing that decides
  // it: the order of the two lines.
  test('the dispatch sits below the resolveUser 401, not above it', async () => {
    const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');

    const gate = source.indexOf("if (!user) return send(res, 401, { error: 'unauthenticated' })");
    const dispatch = source.indexOf("path.startsWith('/bff/games/')");

    assert.notEqual(gate, -1, 'the 401 gate moved or was reworded — re-check this test');
    assert.notEqual(dispatch, -1, 'the /bff/games dispatch moved or was reworded');
    assert.ok(
      gate < dispatch,
      'the /bff/games dispatch is ABOVE the authentication gate: the ROM library would be served to anyone',
    );
  });

  test('games routes are not reachable through the *arr passthrough prefixes', async () => {
    const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
    // `/bff/games` (no trailing slash) must not fall into a backend lookup —
    // BACKENDS only holds radarr/sonarr/prowlarr, so it 404s. Pin that the
    // prefix set stays closed.
    const backends = source.match(/const BACKENDS = \{[\s\S]*?\n\};/)?.[0] ?? '';
    assert.ok(backends.includes('radarr'), 'BACKENDS block not found — re-check this test');
    assert.ok(!backends.includes('games'), 'games must never be an *arr-style passthrough backend');
  });
});

describe('routing', () => {
  test('anything outside the allowlist is a 404, including writes', async () => {
    for (const path of ['/bff/games/', '/bff/games/roms', '/bff/games/library/x']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 404, `unexpected route accepted: ${path}`);
    }
    const post = await fetch(`${baseUrl}/bff/games/library`, { method: 'POST' });
    assert.equal(post.status, 404);
  });
});
