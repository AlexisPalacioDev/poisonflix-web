// Booting and — the hard half — un-booting EmulatorJS.
//
// EmulatorJS has no module build and no instance API: it is configured by
// assigning `window.EJS_*` globals and then loading a script that reads them
// once, on load. That makes it the opposite of a React component — it is
// global, mutable, and it outlives whatever mounted it.
//
// Which is the bug this file exists to prevent. Leave the globals behind and
// the next game inherits the previous one's `EJS_gameUrl`: you tap Zelda and
// Mario boots. Leave the loader `<script>` behind and re-adding it is a no-op
// on some browsers. So teardown deletes EVERY `EJS_`-prefixed global rather
// than the handful we set — the library writes its own (`EJS_emulator`,
// `EJS_terra`, …) and those are just as stale — and removes every node it
// pulled in from `/emulatorjs/`.
//
// The script is injected at runtime, never imported: EmulatorJS plus its cores
// is tens of megabytes, and none of it belongs in a bundle that also has to
// load on a phone that only wants to play music. It is served from the same
// origin under `/emulatorjs/`, so there is no CORS story and no service worker
// involved (`main.tsx` actively unregisters those — nothing here may depend on
// one).

import type { GameSystem } from '../../lib/domain/gameSystems';

const DATA_PATH = '/emulatorjs/data/';
const LOADER_SRC = `${DATA_PATH}loader.js`;
const GLOBAL_PREFIX = 'EJS_';

/** Everything EmulatorJS injects lives under `/emulatorjs/`, ours included. */
const INJECTED_SELECTOR = 'script[src*="/emulatorjs/"], link[href*="/emulatorjs/"]';

export interface EmulatorConfig {
  /** CSS selector of the element the emulator takes over. */
  playerSelector: string;
  /** The core name, which is also our `system` value — see `gameSystems.ts`. */
  core: GameSystem;
  /** Where the ROM streams from (`api/games.ts`'s `romUrl`). */
  gameUrl: string;
  /** Shown by the emulator's own start screen and menus. */
  gameName: string;
  /** Called if the loader script never arrives. Without it the screen is just
   *  black: a deploy may legitimately ship without `/emulatorjs/` present, and
   *  `npm run dev` serves the SPA fallback there, so this is a normal state. */
  onLoadError?: () => void;
}

/** The bits of the running emulator we touch. All optional: builds differ, and
 * teardown must survive one that exposes none of them. */
interface EmulatorInstance {
  pause?: () => void;
  callEvent?: (event: string) => void;
}

type EmulatorWindow = Window & Record<string, unknown> & { EJS_emulator?: EmulatorInstance };

/** Runs one teardown step, swallowing whatever it throws. The global purge is
 * the part that must happen; a build missing one of these methods must not be
 * what stops it. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    /* see above */
  }
}

/** Everything we know how to switch off on a live instance. All optional: the
 *  method that matters is assigned late (see `installInstanceTrap`). */
function shutDown(instance: EmulatorInstance | undefined): void {
  if (!instance) return;
  attempt(() => instance.pause?.());
  attempt(() => instance.callEvent?.('exit'));
}

// Catching the instance the loader builds, so none can outlive us.
//
// `loader.js` is an async IIFE: it awaits `emulator.min.js`, then a stylesheet,
// then a localisation fetch, and only THEN runs
// `window.EJS_emulator = new EmulatorJS(EJS_player, config)`. Nothing cancels
// that. So a loader still in flight when the user leaves game A and opens game
// B resumes, reads B's globals, and constructs a second full emulator into the
// same node: two ROM downloads (twice 600 MB on a PS1 disc), two render loops,
// two audio loops. `window.EJS_emulator` then points at whichever landed last
// and the other is unreachable forever — a zombie no teardown can find.
//
// It cannot be prevented, but it can be made reachable: an accessor on the
// global means every construction passes through here, and any instance that a
// later one supersedes gets shut down on the spot instead of being orphaned.
let trapped: EmulatorInstance | undefined;

// Which boot the running emulator belongs to.
//
// `stopEmulator` is global — it has to be, because so is EmulatorJS. But a
// React cleanup is NOT: leaving game A and opening game B fires A's cleanup
// AFTER B's effect has already booted, and an unscoped teardown then kills the
// emulator that replaced it. Measured on the deployed build: the instance is
// constructed, builds its context menu, menu bar and virtual gamepad, and is
// torn down before it ever reaches its canvas — leaving a black rectangle with
// the right title on it and no error anywhere. So a caller hands back the token
// it was given, and a teardown for a boot that is no longer current does nothing.
let generation = 0;

function installInstanceTrap(): void {
  const w = window as unknown as EmulatorWindow;
  const existing = Object.getOwnPropertyDescriptor(w, 'EJS_emulator');
  if (existing && !('value' in existing)) return; // ours, already installed

  Object.defineProperty(w, 'EJS_emulator', {
    configurable: true,
    // Non-enumerable on purpose: the purge in stopEmulator walks Object.keys,
    // so the trap is skipped without the loop needing to know it exists — and
    // "no EJS_ global survives a stop" stays true for everything that is data.
    enumerable: false,
    get: () => trapped,
    set: (instance: EmulatorInstance) => {
      // A second arrival means a stale loader finished behind us. Whichever we
      // are holding is now the orphan, so stop it before it is forgotten.
      if (trapped && trapped !== instance) shutDown(trapped);
      trapped = instance;
    },
  });
}

/**
 * Points EmulatorJS at a game and loads it.
 *
 * Tears down any previous session first, so a caller that forgets to unmount
 * cleanly still gets the game it asked for rather than the last one.
 *
 * Returns the token for THIS boot; hand it back to `stopEmulator` so a late
 * cleanup cannot tear down whatever booted after it.
 */
export function startEmulator(config: EmulatorConfig): number {
  stopEmulator();
  const mine = ++generation;

  const w = window as unknown as EmulatorWindow;
  w.EJS_player = config.playerSelector;
  w.EJS_core = config.core;
  w.EJS_gameUrl = config.gameUrl;
  w.EJS_gameName = config.gameName;
  w.EJS_pathtodata = DATA_PATH;
  w.EJS_backgroundColor = '#0a0c10';

  // `EJS_startOnLoaded` is deliberately NOT set. Its start screen is one tap,
  // and that tap is what unlocks audio on iOS and Android — autostarting buys
  // a second and costs the sound. The same screen is also where the on-screen
  // gamepad and a paired Bluetooth controller are picked up, both of which
  // EmulatorJS handles on its own once it is running.

  installInstanceTrap();

  // An inserted classic script keeps running even after its node is removed, so
  // a loader in flight when `stopEmulator` runs still finishes. That is not
  // cancellable and this does not pretend otherwise — the trap above makes the
  // instance it builds reachable so it can be shut down, which is the part that
  // actually mattered. What remains after that is one wasted ROM fetch.
  const script = document.createElement('script');
  script.src = LOADER_SRC;
  script.async = true;
  // No `onerror` and the failure is a black rectangle with no explanation. It
  // is a reachable state, not a hypothetical: `deploy.sh` treats a failed
  // EmulatorJS fetch as non-fatal, and `npm run dev` has no `/emulatorjs` route
  // at all — Vite answers the SPA fallback, so the "script" is index.html.
  script.onerror = () => config.onLoadError?.();
  document.body.appendChild(script);

  return mine;
}

/**
 * Removes every trace of the running emulator: the instance, the globals, and
 * the injected nodes. Safe to call when nothing is running.
 *
 * Pass the token `startEmulator` returned and this becomes a no-op once a newer
 * boot has taken over — which is what a React cleanup must do. Called with no
 * token it always tears down, which is what `startEmulator` itself wants.
 */
export function stopEmulator(token?: number): void {
  if (token !== undefined && token !== generation) return;

  const w = window as unknown as EmulatorWindow;

  // What this can and cannot switch off, measured against the library rather
  // than assumed: `pause` is assigned while the control menu is built, which
  // happens AFTER the first tap, so before the user starts the game it is
  // undefined and the optional call is a silent no-op. `callEvent` only emits
  // to listeners we never registered — EmulatorJS fires 'exit', it does not
  // consume it. So the frame loop, the autosave interval and its window
  // listeners can outlive this. Clearing the host and dropping every reference
  // is what reliably ends it; the calls below are best effort on top.
  shutDown(trapped ?? w.EJS_emulator);
  trapped = undefined;

  // Empty the host element - never remove it. `EJS_player` points at a node
  // REACT renders and owns (`<div id="game">`), and the library's own
  // `elements.parent` is that same node. Removing it works by accident on a
  // full unmount, where React has already detached the tree, and breaks the
  // moment the effect merely re-runs (same route, different `:id`): React sees
  // nothing to re-create, so the next game mounts into a selector that matches
  // nothing and the screen stays black. React renders it childless, so clearing
  // what EmulatorJS put inside it is safe.
  const selector = w.EJS_player;
  if (typeof selector === 'string') {
    attempt(() => {
      const host = document.querySelector(selector);
      while (host?.firstChild) host.removeChild(host.firstChild);
    });
  }

  for (const key of Object.keys(w)) {
    if (key.startsWith(GLOBAL_PREFIX)) delete w[key];
  }

  document.querySelectorAll(INJECTED_SELECTOR).forEach((node) => node.remove());
}
