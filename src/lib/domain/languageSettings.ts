// ES⇄EN TMDB metadata language toggle, ported from the projector reference's
// `AppSettings.toggleLanguage` / `LanguageChip` (projector-feature-map.md §3
// top bar, §6 `LanguageInterceptor`). Mirrors `lib/session/store.ts`'s
// localStorage + subscribe pattern (plain `getItem`/`setItem`, `typeof
// localStorage === 'undefined'` guard for SSR/non-browser test environments,
// a `Set` of listeners notified on every write) rather than introducing a new
// persistence mechanism.

const STORAGE_KEY = 'poisonflix:language';

export type AppLanguage = 'es' | 'en';

const DEFAULT_LANGUAGE: AppLanguage = 'es';

type LanguageListener = (language: AppLanguage) => void;
const listeners = new Set<LanguageListener>();

export function subscribeLanguage(listener: LanguageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(language: AppLanguage): void {
  for (const listener of listeners) listener(language);
}

function isAppLanguage(value: string | null): value is AppLanguage {
  return value === 'es' || value === 'en';
}

/** Current app language, defaulting to `'es'` when never set (or in a
 * non-browser environment, e.g. SSR/tests without a `localStorage` polyfill). */
export function getLanguage(): AppLanguage {
  if (typeof localStorage === 'undefined') return DEFAULT_LANGUAGE;
  const raw = localStorage.getItem(STORAGE_KEY);
  return isAppLanguage(raw) ? raw : DEFAULT_LANGUAGE;
}

export function setLanguage(language: AppLanguage): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, language);
  notify(language);
}

/** Flips ES⇄EN, persists it, and notifies subscribers - the toggle behind
 * the header's `LanguageChip` (`Header.tsx`). */
export function toggleLanguage(): AppLanguage {
  const next: AppLanguage = getLanguage() === 'es' ? 'en' : 'es';
  setLanguage(next);
  return next;
}

/**
 * Maps the app language to the TMDB `language` query param jellyseerr expects
 * (`src/api/jellyseerr.ts`'s `search`/`discoverTrending`/`getMovieDetails`/
 * `getTvDetails`) - `'es-MX'` (not a bare ISO-639-1 `'es'`) for Spanish,
 * mirroring the projector reference's `LanguageInterceptor` (`es-MX`/`en`).
 */
export function tmdbLanguageParam(language: AppLanguage = getLanguage()): string {
  return language === 'es' ? 'es-MX' : 'en';
}
