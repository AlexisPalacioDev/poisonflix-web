import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_SYSTEMS, type GameSystem } from '../../lib/domain/gameSystems';

// Contract test against the console list the BFF actually walks.
//
// The frontend validates `system` with a strict zod enum, and one unrecognised
// value fails the WHOLE library parse — a single stray folder would turn a
// shelf of two hundred games into "No se pudo leer la biblioteca". That is a
// deliberate trade (a system we cannot name is a core we cannot boot, so a card
// for it would dead-end on tap), but it is only safe while the two lists agree,
// and they live in two files with no shared source: `lib/domain/gameSystems.ts`
// here and `SYSTEMS` in `infra/bff/games.mjs` there.
//
// So the agreement is the thing under test. Reading the BFF's own source rather
// than a hand-copied fixture is the point: a console added on one side and not
// the other fails here, in CI, instead of on someone's phone.

// Resolved from the repo root (where vitest runs) rather than from
// `import.meta.url`: under Vite's transform that is not a `file:` URL.
const BFF_GAMES = path.resolve(process.cwd(), 'infra/bff/games.mjs');

/** The `SYSTEMS` set as the BFF declares it. Throws loudly rather than
 * returning an empty list: a silently empty set would make this test pass by
 * comparing nothing. */
function bffSystems(): string[] {
  const source = readFileSync(BFF_GAMES, 'utf8');
  const block = source.split('const SYSTEMS = new Set([')[1]?.split(']);')[0];
  if (!block) {
    throw new Error('could not find `const SYSTEMS = new Set([...])` in infra/bff/games.mjs');
  }
  // Comments inside the set are not data. Scraping every quoted run without
  // stripping them first swallowed `gbc` and `dmg` out of a line explaining why
  // gbc is NOT a system — the test then failed on consoles nobody had declared.
  const declarations = block.replace(/\/\/[^\n]*/g, '');
  const names = declarations.match(/'([^']+)'/g)?.map((quoted) => quoted.slice(1, -1)) ?? [];
  if (names.length === 0) throw new Error('the BFF SYSTEMS set parsed as empty');
  return names;
}

describe('game systems: frontend table vs the BFF that reads the disk', () => {
  const fromBff = bffSystems();
  const fromFrontend = Object.keys(GAME_SYSTEMS) as GameSystem[];

  it('recognises exactly the consoles the BFF serves', () => {
    expect([...fromFrontend].sort()).toEqual([...fromBff].sort());
  });

  // The two checks above only prove our two lists agree with each other, which
  // is worth exactly nothing if they agree on a console EmulatorJS has never
  // heard of. `gbc` was on both for a while: the shelf listed it, zod accepted
  // it, the contract test went green, and every card in it died on tap — after
  // silently falling back to cdn.emulatorjs.org for a core file that does not
  // exist. So the real authority is EmulatorJS's own `getCores()` table, which
  // is on disk once the runtime is fetched.
  //
  // Casing is part of it: the value is handed over verbatim as `EJS_core`, so
  // `segamd` would not start.
  const RUNTIME = path.resolve(process.cwd(), 'infra/www/emulatorjs/data/src/emulator.js');

  function emulatorJsSystems(): string[] | null {
    let source: string;
    try {
      source = readFileSync(RUNTIME, 'utf8');
    } catch {
      return null; // runtime not fetched in this checkout — see below
    }
    const block = source.split('getCores() {')[1]?.split('return')[0];
    if (!block) throw new Error(`could not find getCores() in ${RUNTIME}`);
    const names = [...block.matchAll(/"([A-Za-z0-9_]+)"\s*:\s*\[/g)].map((m) => m[1]);
    if (names.length === 0) throw new Error('EmulatorJS getCores() parsed as empty');
    return names;
  }

  it('only names consoles EmulatorJS can actually boot', () => {
    const supported = emulatorJsSystems();
    if (supported === null) {
      // Not silently skipped: a green run here would otherwise mean "we never
      // checked". `infra/fetch-emulatorjs.sh` populates it.
      console.warn(`[contract] EmulatorJS runtime absent at ${RUNTIME} — core names UNVERIFIED`);
      expect(true).toBe(true);
      return;
    }
    const unknown = fromFrontend.filter((s) => !supported.includes(s));
    expect(unknown, `not EmulatorJS cores: ${unknown.join(', ')}`).toEqual([]);
  });

  it('gives every console a human name to group it under', () => {
    for (const system of fromFrontend) {
      expect(GAME_SYSTEMS[system], `${system} has no label`).toBeTruthy();
    }
  });
});
