// The consoles the emulator can boot, and what to call them on screen.
//
// This table is the single source of truth for three things that must never
// drift apart: the `system` values the BFF is allowed to send
// (`api/schemas/games.ts` builds its zod enum from these keys), the name
// EmulatorJS wants for its `EJS_core`, and the heading the library groups
// games under. They are the same string on purpose — a system we cannot name
// is a system we cannot boot, so there is nothing to reconcile.
//
// Declaration order is presentation order: Nintendo, Sony, Sega, Atari, then
// the rest. The library groups follow it, which is why this is an object
// literal and not a set.
//
// A key here MUST exist in EmulatorJS's own core table — it is handed over as
// `EJS_core` verbatim. `gbc` was on this list and is not one of them: gambatte
// declares `extensions: ['gb','gbc','dmg']`, so Game Boy Color ROMs are a file
// type under `gb`, not a console of their own. The shelf happily listed a
// `gbc/` folder, and every card in it died on tap with "Error downloading core"
// — after silently reaching out to cdn.emulatorjs.org for a file that has never
// existed. See the runtime check in `api/schemas/games.contract.test.ts`.

export const GAME_SYSTEMS = {
  nes: 'NES',
  snes: 'Super Nintendo',
  n64: 'Nintendo 64',
  /** Also Game Boy Color: gambatte reads .gb, .gbc and .dmg. */
  gb: 'Game Boy / Color',
  gba: 'Game Boy Advance',
  nds: 'Nintendo DS',
  vb: 'Virtual Boy',
  psx: 'PlayStation',
  psp: 'PlayStation Portable',
  segaMD: 'Sega Mega Drive',
  segaCD: 'Sega CD',
  segaSaturn: 'Sega Saturn',
  sega32x: 'Sega 32X',
  segaMS: 'Master System',
  segaGG: 'Game Gear',
  atari2600: 'Atari 2600',
  atari7800: 'Atari 7800',
  lynx: 'Atari Lynx',
  jaguar: 'Atari Jaguar',
  pce: 'PC Engine',
  ngp: 'Neo Geo Pocket',
  ws: 'WonderSwan',
  '3do': '3DO',
  arcade: 'Arcade',
  coleco: 'ColecoVision',
  c64: 'Commodore 64',
} as const;

export type GameSystem = keyof typeof GAME_SYSTEMS;

/** Presentation order, straight off the table above. */
export const GAME_SYSTEM_ORDER = Object.keys(GAME_SYSTEMS) as readonly GameSystem[];

/** The heading a system is grouped under. */
export function gameSystemLabel(system: GameSystem): string {
  return GAME_SYSTEMS[system];
}
