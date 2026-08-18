// Text folding for in-memory search boxes.
//
// The owner types in Spanish and does not reach for the accent key while
// filtering a shelf: "pokemon" has to find "Pokémon", "asterix" has to find
// "Astérix". Comparing the raw strings makes those searches silently return
// nothing, which reads as "I don't own that game" rather than "you missed an
// accent".
//
// Unicode does the work, not a hand-written á→a table: NFD splits an accented
// letter into its base letter plus a combining mark, and dropping the marks
// leaves the base letter behind. A table would cover the five vowels someone
// thought of and miss ü, ç, ō and every other mark a ROM title can carry.
//
// The limit, stated plainly: this folds letters that DECOMPOSE into a base plus
// a mark. Letters that are their own code point with no decomposition — ø, ł,
// đ, æ — are left alone, because there is no mark to drop. Those need a table
// after all, and none of the consoles here has enough of them to earn one.

// The combining diacritical marks block, matched by code point rather than by
// `\p{Diacritic}`: unicode property escapes need the /u flag and Chrome 53 —
// the webOS 2018 browser this app still has to run on — does not parse them,
// which would throw at module load and take the whole screen down with it.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * A comparable form of `value`: lowercase, accent-free, trimmed.
 *
 * Only for matching. Never render the result — it is a search key, and showing
 * it would strip the accents off the title the user is reading.
 */
export function foldForSearch(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim();
}
