import { afterEach, describe, expect, it, vi } from 'vitest';
import { startEmulator, stopEmulator } from './emulatorjs';

// EmulatorJS is configured through `window` and loaded by a <script> tag, so
// "did we clean up?" is a question about globals and DOM nodes - exactly what
// this can assert without the library itself being present.

type MutableWindow = Window & Record<string, unknown>;

/** `window`, addressable by key.
 *
 * The cast goes through `unknown` on purpose: `Window` has no index signature,
 * so TypeScript rejects the direct conversion (TS2352). One helper says that
 * once instead of fifteen bare casts repeating it — and the bare version type
 * checked under the root tsconfig, which references the real projects and
 * checks no files itself, so it only surfaced in `npm run build`. */
const mut = (): MutableWindow => window as unknown as MutableWindow;

function ejsGlobals(): string[] {
  return Object.keys(mut()).filter((key) => key.startsWith('EJS_'));
}

function loaderScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/emulatorjs/"]'));
}

const SNES = {
  playerSelector: '#game',
  core: 'snes',
  gameUrl: '/bff/games/rom?id=zelda',
  gameName: 'Zelda',
} as const;

const N64 = {
  playerSelector: '#game',
  core: 'n64',
  gameUrl: '/bff/games/rom?id=mario64',
  gameName: 'Mario 64',
} as const;

describe('EmulatorJS lifecycle', () => {
  afterEach(() => {
    stopEmulator();
  });

  it('publishes the globals the loader reads, then injects the loader', () => {
    startEmulator(SNES);

    const w = mut();
    expect(w.EJS_player).toBe('#game');
    expect(w.EJS_core).toBe('snes');
    expect(w.EJS_gameUrl).toBe('/bff/games/rom?id=zelda');
    expect(w.EJS_pathtodata).toBe('/emulatorjs/data/');

    const scripts = loaderScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toContain('/emulatorjs/data/loader.js');
  });

  it('stopping removes every EJS_ global, including the ones the library set itself', () => {
    startEmulator(SNES);
    // Stand-ins for what EmulatorJS writes once it boots. Cleanup must not be
    // limited to the handful of keys we happen to set.
    mut().EJS_emulator = {};
    mut().EJS_terra = 'whatever';

    stopEmulator();

    expect(ejsGlobals()).toEqual([]);
    expect(loaderScripts()).toHaveLength(0);
  });

  it('tears the running instance down before purging it', () => {
    const pause = vi.fn();
    const callEvent = vi.fn();
    startEmulator(SNES);
    mut().EJS_emulator = { pause, callEvent };

    stopEmulator();

    expect(pause).toHaveBeenCalled();
    expect(callEvent).toHaveBeenCalledWith('exit');
  });

  // The host element belongs to React, not to us. Removing it works by accident
  // on a full unmount (React has already detached the tree) and breaks the
  // moment the effect merely re-runs: React sees nothing to re-create, so the
  // next game mounts into a selector that matches nothing and the screen stays
  // black.
  it('empties the host element without removing it', () => {
    const host = document.createElement('div');
    host.id = 'game';
    document.body.appendChild(host);
    startEmulator(SNES);
    // What EmulatorJS builds inside the node it was pointed at.
    host.appendChild(document.createElement('canvas'));
    host.appendChild(document.createElement('div'));

    stopEmulator();

    expect(document.getElementById('game')).toBe(host);
    expect(host.childNodes).toHaveLength(0);
    host.remove();
  });

  it('a second game finds its host element still there', () => {
    const host = document.createElement('div');
    host.id = 'game';
    document.body.appendChild(host);

    startEmulator(SNES);
    host.appendChild(document.createElement('canvas'));
    startEmulator(N64);

    expect(document.querySelector('#game')).toBe(host);
    expect(mut().EJS_core).toBe('n64');
    host.remove();
  });

  it('survives an instance whose teardown throws, and still purges the globals', () => {
    startEmulator(SNES);
    mut().EJS_emulator = {
      pause: () => {
        throw new Error('core already gone');
      },
    };

    expect(() => stopEmulator()).not.toThrow();
    expect(ejsGlobals()).toEqual([]);
  });

  // The bug this whole module exists for: the globals are the configuration,
  // so a leftover `EJS_gameUrl` means the next game boots the previous one.
  it('starting a second game never leaves the first one behind', () => {
    startEmulator(SNES);
    stopEmulator();

    startEmulator(N64);

    const w = mut();
    expect(w.EJS_core).toBe('n64');
    expect(w.EJS_gameUrl).toBe('/bff/games/rom?id=mario64');
    expect(loaderScripts()).toHaveLength(1);
  });

  it('starting without a stop first still replaces the previous game outright', () => {
    startEmulator(SNES);

    startEmulator(N64);

    expect(mut().EJS_gameUrl).toBe('/bff/games/rom?id=mario64');
    // One loader, not two stacked on top of each other.
    expect(loaderScripts()).toHaveLength(1);
  });

  it('stopping when nothing is running is a no-op', () => {
    expect(() => stopEmulator()).not.toThrow();
    expect(ejsGlobals()).toEqual([]);
  });

  // The race the accessor exists for. `loader.js` is async: it awaits three
  // things before running `window.EJS_emulator = new EmulatorJS(...)`. Nothing
  // cancels an inserted script, so a loader from a game the user already left
  // resumes and constructs anyway. Before the trap, the global held whichever
  // landed last and the other ran forever with nobody holding a reference.
  it('shuts down an instance that a later loader supersedes', () => {
    const first = { pause: vi.fn(), callEvent: vi.fn() };
    const second = { pause: vi.fn(), callEvent: vi.fn() };

    startEmulator(SNES);
    // Two loaders finish, in flight order, both assigning the global.
    (window as unknown as Record<string, unknown>).EJS_emulator = first;
    (window as unknown as Record<string, unknown>).EJS_emulator = second;

    // The superseded one is stopped at the moment it is superseded, not left
    // for a teardown that can no longer see it.
    expect(first.pause).toHaveBeenCalled();
    expect(second.pause).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>).EJS_emulator).toBe(second);

    stopEmulator();
    expect(second.pause).toHaveBeenCalled();
  });

  // Without this the hole reopens after the user leaves games entirely: the
  // purge would delete the accessor, and a loader resuming afterwards would
  // assign a plain property nothing can reach.
  it('keeps trapping instances after a full teardown', () => {
    startEmulator(SNES);
    stopEmulator();

    const late = { pause: vi.fn(), callEvent: vi.fn() };
    (window as unknown as Record<string, unknown>).EJS_emulator = late;
    const later = { pause: vi.fn(), callEvent: vi.fn() };
    (window as unknown as Record<string, unknown>).EJS_emulator = later;

    expect(late.pause).toHaveBeenCalled();
  });

  it('reports a loader that never arrives instead of leaving a black screen', () => {
    const onLoadError = vi.fn();
    startEmulator({ ...SNES, onLoadError });

    const script = document.querySelector('script[src*="/emulatorjs/"]');
    script?.dispatchEvent(new Event('error'));

    expect(onLoadError).toHaveBeenCalled();
  });
});
