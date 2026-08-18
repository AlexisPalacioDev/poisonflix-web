// The deploy contract for cast-bridge, asserted against infra/deploy.sh and
// infra/docker-compose.yml as text.
//
//   node --test "infra/cast-bridge/**/*.test.mjs"
//
// A test that reads a shell script is a strange thing, so: the defect this
// pins was not in any code path a runtime test can reach. `deploy.sh` built
// `bff music-worker` and nothing else, so cast-bridge was never started on any
// deploy — while the BFF, by a deliberate contract in bff/cast.mjs, answered
// `{ devices: [] }` with HTTP 200 for a bridge that is not there. Every unit
// test passed, every smoke test passed, the script printed "deploy OK", and the
// feature was dead on the television for as long as anyone cared to look.
//
// The same script already carries a comment about having made this exact
// mistake with music-worker. It happened twice because nothing checked.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let deploy;
let compose;

before(async () => {
  deploy = await readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
  compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
});

describe('deploy.sh starts cast-bridge', () => {
  test('the service is in the build line, not just in the compose file', () => {
    const buildLines = deploy
      .split('\n')
      .filter((line) => /^docker compose up -d --build\b/.test(line.trim()));
    assert.ok(buildLines.length > 0, 'deploy.sh must build images somewhere');
    assert.ok(
      buildLines.some((line) => /\bcast-bridge\b/.test(line)),
      'cast-bridge is defined in docker-compose.yml but never built or started by deploy.sh',
    );
  });

  test('the compose file still declares the service that line names', () => {
    assert.match(compose, /^ {2}cast-bridge:/m);
  });
});

describe('deploy.sh creates the pairing store before Docker can', () => {
  test('the bind mount is relative, which is what makes this necessary', () => {
    // A relative bind that does not exist is created by Docker as root:root on
    // first `up`. The container runs `USER node` (uid 1000, see the Dockerfile),
    // so storeKey() then fails with EACCES on every pairing and the LG puts its
    // permission dialog on screen at every single cast — silently, because a
    // failed key write does not stop a cast that already worked.
    assert.match(compose, /-\s+\.\/cast-bridge\/data:\/data/);
  });

  test('deploy.sh mkdirs exactly that path', () => {
    assert.match(deploy, /mkdir -p cast-bridge\/data/);
  });

  test('and checks the uid inside the container can write to it', () => {
    // Owning it is not enough: it has to be owned by uid 1000. A host that
    // deploys as another uid reproduces the same EACCES.
    assert.match(deploy, /chown 1000:1000 cast-bridge\/data/);
  });
});

describe('the smoke test can tell a dead bridge from a house with the TVs off', () => {
  test('it probes the BFF route for the security boundary', () => {
    assert.match(deploy, /\/bff\/cast\/devices/);
    assert.match(deploy, /cast_route.*401|401.*cast_route/s);
  });

  test('it probes the bridge itself, because the BFF route is 200 either way', () => {
    // This is the assertion that matters. `/bff/cast/devices` answers 401
    // without a session and 200 with one WHETHER OR NOT the bridge is running —
    // that is the documented degradation in bff/cast.mjs. A smoke test built
    // only on it is green while the feature is dead, which is the bug being
    // fixed here. /healthz is answered by the bridge process and depends on no
    // television being powered on.
    assert.match(deploy, /:8791\/healthz/);
  });

  test('it asks compose for the address instead of re-parsing .env', () => {
    // The previous version of this check compared the two hardcoded DEFAULTS
    // and passed while the real parsing diverged. Measured divergence: with
    // `CAST_GATEWAY_IP=172.19.0.1 # media-automation` in .env, compose binds to
    // 172.19.0.1 and a naive `awk -F=` yields `172.19.0.1 # media-automation`,
    // so the smoke test builds a nonsense URL, gets 000, and calls a healthy
    // bridge dead. Quotes, a trailing space and a CRLF do the same. There must
    // be exactly ONE parser of that setting, and it must be compose's.
    assert.match(deploy, /docker compose config[\s\S]{0,200}CAST_BRIDGE_BIND/);
    assert.doesNotMatch(
      deploy,
      /awk[^\n]*CAST_GATEWAY_IP/,
      'deploy.sh must not hand-parse CAST_GATEWAY_IP out of .env',
    );
  });

  test('reading it cannot kill the deploy when infra/.env is missing', () => {
    // `set -o pipefail` plus a failing command in a pipeline inside `$(...)`
    // aborts the whole script with no output at all — a deploy that already
    // succeeded dying mute, which is worse than the problem being reported.
    const line = deploy.split('\n').find((l) => l.includes('CAST_BRIDGE_BIND'));
    assert.ok(line, 'the gateway must be read from compose');
    assert.match(line, /\|\| true/);
  });

  test('a dead bridge changes the LAST line, not just a warning on stderr', () => {
    // The assertion this replaces only checked that the strings `cast_ok=0` and
    // an `if` existed — it would have passed with an empty warning. The defect
    // it missed is the one that matters: `cast_ok` fed nothing, so a dead
    // bridge printed warnings to stderr and then `==> deploy OK (local +
    // public)` to stdout. The last line is the one anybody reads.
    const summaries = deploy.split('\n').filter((l) => /echo "==> deploy OK/.test(l));
    assert.ok(summaries.length >= 2, 'expected the existing deploy OK summary lines');
    for (const line of summaries) {
      assert.match(
        line,
        /\$cast_note/,
        `summary line must carry the cast caveat, got: ${line.trim()}`,
      );
    }
    assert.match(deploy, /cast_note=' — CASTING IS DOWN \(see above\)'/);
  });
});
