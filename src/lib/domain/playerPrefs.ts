import { languageFamily } from './languageNames';

// Subtitle preference persistence + initial-subtitle resolution, ported from
// the projector reference's `AppSettings.subtitlePreference` /
// `AppSettings.setSubtitlePreference` and `PlayerViewModel.resolveInitialSubtitle`
// (player spec §8, projector-feature-map.md §8 "Subtitle auto rule +
// persisted preference"). Mirrors `lib/session/store.ts`'s localStorage
// pattern (plain `getItem`/`setItem`, `typeof localStorage === 'undefined'`
// guard for SSR/non-browser test environments) rather than introducing a new
// persistence mechanism.

const STORAGE_KEY = 'poisonflix:subtitlePreference';

/** Sentinel stored when the user explicitly picks "Ninguno" - distinct from
 * "no preference saved yet" (`null`), which falls through to the AUTO rule. */
export const SUBTITLE_OFF = '__off__';

/** Raw saved preference: `null` (never set), `SUBTITLE_OFF`, or a language
 * family key (e.g. `"es"`, `"en"`) - see `resolveInitialSubtitle`. */
export function getSubtitlePreference(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY);
}

/** Persists the user's explicit subtitle choice. Pass `SUBTITLE_OFF` for
 * "Ninguno", or a language family key for a chosen track. */
export function setSubtitlePreference(value: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, value);
}

/** Test/reset helper - clears the saved preference back to "never set". */
export function clearSubtitlePreference(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Derives the preference key to persist for a given selection - the
 * language family when known, else the track's own display label (mirrors
 * `languageFamily(track.language) ?: track.label` in the Kotlin reference),
 * or `SUBTITLE_OFF` for "Ninguno" (`track === null`). */
export function subtitlePreferenceKeyFor(
  track: { language: string | null; displayTitle: string } | null,
): string {
  if (!track) return SUBTITLE_OFF;
  return languageFamily(track.language) ?? track.displayTitle;
}

/** Minimal shape `resolveInitialSubtitle` needs - any richer track type
 * (e.g. `MediaStreamTrack` in `features/player/mediaStreamTracks.ts`)
 * structurally satisfies this without an explicit import, keeping this
 * domain module free of a dependency on the feature layer. */
export interface SubtitleCandidate {
  index: number;
  language: string | null;
  isDefault: boolean;
  isForced: boolean;
}

/**
 * Picks the subtitle to enable when playback opens (player spec §8):
 *  1. Saved preference `SUBTITLE_OFF` -> none.
 *  2. Saved preference is a language family with a matching track -> the
 *     best track in that family.
 *  3. Saved preference is a family with NO matching track (or was never
 *     set) -> AUTO rule: subtitles ON in [appLanguage] when the default
 *     audio isn't in that language family; otherwise none.
 * "Best" within a family = default wins, then non-forced over forced, then
 * lowest stream index for stability - ported verbatim from
 * `PlayerViewModel.resolveInitialSubtitle`'s `bestFor`.
 */
export function resolveInitialSubtitle<T extends SubtitleCandidate>(
  subtitles: T[],
  defaultAudioLanguage: string | null,
  appLanguage = 'es',
): T | null {
  if (subtitles.length === 0) return null;

  const bestFor = (family: string | null): T | null => {
    if (family == null) return null;
    let best: T | null = null;
    for (const track of subtitles) {
      if (languageFamily(track.language) !== family) continue;
      if (!best) {
        best = track;
        continue;
      }
      if (track.isDefault !== best.isDefault) {
        if (track.isDefault) best = track;
        continue;
      }
      if (track.isForced !== best.isForced) {
        if (!track.isForced) best = track;
        continue;
      }
      if (track.index < best.index) best = track;
    }
    return best;
  };

  const pref = getSubtitlePreference();
  if (pref === SUBTITLE_OFF) return null;
  if (pref !== null) {
    const match = bestFor(pref);
    if (match) return match;
    // Saved family has no matching track in this file - fall through to AUTO.
  }

  const appFamily = languageFamily(appLanguage);
  const audioFamily = languageFamily(defaultAudioLanguage);
  return audioFamily !== appFamily ? bestFor(appFamily) : null;
}
