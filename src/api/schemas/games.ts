import { z } from 'zod';
import { GAME_SYSTEM_ORDER, type GameSystem } from '../../lib/domain/gameSystems';

// Juegos feature schemas. The BFF walks `${DATA_DIR}/games/<sistema>/` and
// reports what it finds; nothing here is stored, so the library is whatever is
// on disk right now.

// Built from the domain table rather than re-typed, so adding a console is one
// edit in `lib/domain/gameSystems.ts` instead of two that can disagree.
export const GameSystemSchema = z.enum(GAME_SYSTEM_ORDER as [GameSystem, ...GameSystem[]]);

// A ROM the server can stream. `id` is opaque — the only thing the client does
// with it is hand it back on `/games/rom?id=`.
//
// `system` is validated strictly, and that is deliberate: a value we do not
// recognise cannot be given to EmulatorJS as a core, so a game carrying one is
// not a game we could boot anyway. Failing the request loudly beats rendering
// a card that dead-ends on tap.
export const GameSchema = z.object({
  id: z.string(),
  title: z.string(),
  system: GameSystemSchema,
  sizeBytes: z.number(),
});
export type Game = z.infer<typeof GameSchema>;

export const GamesLibraryResponseSchema = z.object({
  games: z.array(GameSchema).default([]),
});
export type GamesLibraryResponse = z.infer<typeof GamesLibraryResponseSchema>;
