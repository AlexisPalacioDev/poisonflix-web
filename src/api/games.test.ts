import { afterEach, describe, expect, it, vi } from 'vitest';

// The prefix every BFF call sits under is env-driven (`VITE_BFF_BASE`), and a
// hardcoded '/bff/...' silently ignores it — the failure mode is a deploy that
// serves the app from one prefix and asks for covers on another, which looks
// like "the server has no cover art" rather than like a bug.
//
// Asserting the default output proves nothing: `apiUrl` falls back to exactly
// '/bff', so a literal produces a byte-identical string. The env has to be
// moved for the test to be able to fail. `BASE_URLS` is read once at module
// load, hence the resetModules + dynamic import.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadWithBffBase(base: string | undefined) {
  if (base === undefined) vi.stubEnv('VITE_BFF_BASE', '');
  else vi.stubEnv('VITE_BFF_BASE', base);
  vi.resetModules();
  return import('./games');
}

describe('gameCoverUrl', () => {
  it('follows VITE_BFF_BASE instead of a hardcoded prefix', async () => {
    const { gameCoverUrl } = await loadWithBffBase('https://media.example/api');

    expect(gameCoverUrl('g1')).toBe('https://media.example/api/games/cover?id=g1');
  });

  it('percent-encodes the id, which is a path and carries slashes and spaces', async () => {
    const { gameCoverUrl } = await loadWithBffBase('/bff');

    expect(gameCoverUrl('snes/Chrono Trigger & Co.sfc')).toBe(
      '/bff/games/cover?id=snes%2FChrono%20Trigger%20%26%20Co.sfc',
    );
  });
});

describe('romUrl', () => {
  // Same rule, same reason — asserted here so the two URL builders cannot
  // drift, since only one of them has a screen looking at it.
  it('follows VITE_BFF_BASE too', async () => {
    const { romUrl } = await loadWithBffBase('https://media.example/api');

    expect(romUrl('snes/g1.sfc')).toBe('https://media.example/api/games/rom?id=snes%2Fg1.sfc');
  });
});
