// Human-readable language names for player track menus (player spec §8's
// "Audio/subtitle track switching"), ported from the projector reference's
// `TrackMenu.kt` (`languageDisplayName`) and `domain/model/LanguageFamily.kt`
// (`languageFamily`). Both take a raw Jellyfin `MediaStream.Language` code
// (ISO 639-2/B, e.g. `eng`, `spa`, `und`) - Jellyfin does NOT send ISO 639-1
// here, so this maps the 3-letter codes directly rather than using
// `Intl.DisplayNames` (which expects 639-1 and would mis-render `und`/`zho`).

const SPANISH_CODES = new Set(['spa', 'spl', 'esp', 'lat']);
const ENGLISH_CODES = new Set(['eng']);

/**
 * Human-readable Spanish name for a stream's language, so the track menu
 * reads "Español" / "Inglés" instead of the raw `spa` / `eng` ISO code.
 * Falls back to [fallback] (already-computed label - e.g. a DisplayTitle, or
 * an uppercased code) for anything not in the explicit map below - this
 * includes `und` (undetermined) and any language this list doesn't cover.
 */
export function languageDisplayName(code: string | null | undefined, fallback: string): string {
  const c = code?.toLowerCase().slice(0, 3);
  if (!c) return fallback;
  if (c.startsWith('es') || SPANISH_CODES.has(c)) return 'Español';
  if (c.startsWith('en') || ENGLISH_CODES.has(c)) return 'Inglés';
  if (c.startsWith('fr') || c === 'fra' || c === 'fre') return 'Francés';
  if (c.startsWith('pt') || c === 'por') return 'Portugués';
  if (c.startsWith('de') || c === 'deu' || c === 'ger') return 'Alemán';
  if (c.startsWith('it') || c === 'ita') return 'Italiano';
  if (c.startsWith('ja') || c === 'jpn') return 'Japonés';
  if (c.startsWith('ko') || c === 'kor') return 'Coreano';
  if (c.startsWith('zh') || c === 'zho' || c === 'chi') return 'Chino';
  if (c.startsWith('ru') || c === 'rus') return 'Ruso';
  if (c.startsWith('ar') || c === 'ara') return 'Árabe';
  if (c.startsWith('nl') || c === 'nld' || c === 'dut') return 'Neerlandés';
  return fallback;
}

/**
 * Normalizes a raw stream language code to a coarse "family" key used to
 * match tracks against the app language and the user's saved subtitle
 * preference (player spec's AUTO rule + saved-preference matching).
 * Spanish's several codes (`spa`, `es`, `spl`, `lat`, ...) collapse to `"es"`;
 * English's (`en`/`eng`) to `"en"`. Unmapped languages return their own
 * (lowercased, 3-char) code so e.g. French still matches itself across
 * differently-tagged tracks. `null`/empty input returns `null`.
 */
export function languageFamily(code: string | null | undefined): string | null {
  const c = code?.toLowerCase().slice(0, 3);
  if (!c) return null;
  if (c.startsWith('es') || SPANISH_CODES.has(c)) return 'es';
  if (c.startsWith('en') || c === 'eng') return 'en';
  return c;
}
