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

// ---------------------------------------------------------------------------
// Second subtitle preference (owner request: two subtitles at once - "leer
// el inglés mientras escucha, con el español al lado" - a language-learning
// feature, not accessibility). Persisted SEPARATELY from the primary
// subtitle preference above, same reasoning as audio vs. subtitle each
// getting their own key: the two languages are picked independently (e.g.
// primary=English to read along, second=Spanish for meaning), so sharing one
// storage key would make picking one silently clobber the other. Also
// keyed by LANGUAGE, not stream index, for the same reason every other
// preference in this file is - stream indices are meaningless across titles.
// ---------------------------------------------------------------------------

const SECOND_SUBTITLE_STORAGE_KEY = 'poisonflix:secondSubtitlePreference';

/** Raw saved preference: `null` (never set), `SUBTITLE_OFF`, or a language
 * family key - see `resolveInitialSecondSubtitle`. Reuses the primary
 * subtitle's `SUBTITLE_OFF` sentinel value (an implementation-detail string,
 * not tied to a particular storage key). */
export function getSecondSubtitlePreference(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SECOND_SUBTITLE_STORAGE_KEY);
}

/** Persists the user's explicit second-subtitle choice. Pass `SUBTITLE_OFF`
 * for "no second subtitle", or a language family key for a chosen track. */
export function setSecondSubtitlePreference(value: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SECOND_SUBTITLE_STORAGE_KEY, value);
}

/** Test/reset helper - clears the saved preference back to "never set". */
export function clearSecondSubtitlePreference(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(SECOND_SUBTITLE_STORAGE_KEY);
}

/** Mirrors `subtitlePreferenceKeyFor` for the second subtitle slot. */
export function secondSubtitlePreferenceKeyFor(
  track: { language: string | null; displayTitle: string } | null,
): string {
  if (!track) return SUBTITLE_OFF;
  return languageFamily(track.language) ?? track.displayTitle;
}

/**
 * Picks the second subtitle to enable when playback opens:
 *  1. Saved preference `SUBTITLE_OFF`, or never set -> none. UNLIKE the
 *     primary subtitle, there is no AUTO rule here - the owner asked for a
 *     manual toggle that is REMEMBERED once used, not one that turns itself
 *     on for someone who never asked for two subtitles.
 *  2. Saved preference is a language family with a matching track -> the
 *     best track in that family (same tie-break as `resolveInitialSubtitle`:
 *     default wins, then non-forced over forced, then lowest index).
 *  3. The match can never be the SAME stream as `primaryIndex` - picking one
 *     subtitle as both "primary" and "second" would render the same line
 *     twice instead of two different languages.
 */
export function resolveInitialSecondSubtitle<T extends SubtitleCandidate>(
  subtitles: T[],
  primaryIndex: number | null,
): T | null {
  if (subtitles.length === 0) return null;

  const pref = getSecondSubtitlePreference();
  if (pref === null || pref === SUBTITLE_OFF) return null;

  let best: T | null = null;
  for (const track of subtitles) {
    if (languageFamily(track.language) !== pref) continue;
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

  if (best && best.index === primaryIndex) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Word-highlight preference (owner request: "resaltar la palabra que se está
// pronunciando" - follow the English audio with your eyes. English-only by
// design, see `subtitleCues.ts`'s header; this flag is just the on/off
// switch, language routing lives in `VideoSurface.tsx`). Persisted
// separately from every subtitle-selection preference above - this is a
// display toggle, not a track choice, and applies across whichever language
// pair the owner happens to have picked.
//
// Defaults to ON: the owner asked for this feature, so a first-time viewer
// sees it; `setWordHighlightPreference(false)` is the explicit opt-out the
// owner also asked for ("debe poder apagarse"). Stored as a plain '0'/'1'
// string, not JSON - mirrors every other boolean-ish flag in this file
// (`SUBTITLE_OFF`), no need for a parser.
// ---------------------------------------------------------------------------

const WORD_HIGHLIGHT_STORAGE_KEY = 'poisonflix:wordHighlightPreference';

/** `true` unless the owner explicitly turned it off - see this section's
 * header for why ON is the default. */
export function getWordHighlightPreference(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(WORD_HIGHLIGHT_STORAGE_KEY) !== '0';
}

export function setWordHighlightPreference(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(WORD_HIGHLIGHT_STORAGE_KEY, enabled ? '1' : '0');
}

/** Test/reset helper - clears the saved preference back to "never set" (i.e.
 * back to the ON default). */
export function clearWordHighlightPreference(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(WORD_HIGHLIGHT_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Audio preference
// ---------------------------------------------------------------------------

const AUDIO_STORAGE_KEY = 'poisonflix:audioPreference';

/**
 * The remembered audio LANGUAGE, or null if never chosen.
 *
 * A language, not a stream index, for the same reason the subtitle preference
 * is: track 2 is Spanish in one release and a director's commentary in the
 * next, so an index remembered from one file is meaningless in another.
 */
export function getAudioPreference(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(AUDIO_STORAGE_KEY);
}

export function setAudioPreference(value: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUDIO_STORAGE_KEY, value);
}

/** Test/reset helper - clears the saved preference back to "never set". */
export function clearAudioPreference(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(AUDIO_STORAGE_KEY);
}

export function audioPreferenceKeyFor(
  track: { language: string | null; displayTitle: string },
): string {
  return languageFamily(track.language) ?? track.displayTitle;
}

export interface AudioCandidate {
  index: number;
  language: string | null;
  isDefault: boolean;
}

/**
 * Picks the audio track to open with:
 *  1. The saved language, if this file has a matching track.
 *  2. Otherwise, AUTO rule: Spanish, if this file has it - a release marking
 *     English as its own default (`IsDefault`) must not silently play in
 *     English when a Spanish track exists (owner's rule: "nunca debe faltar
 *     el español" - reported live on "The Punisher: One Last Kill", which
 *     opened in English despite carrying embedded Spanish subtitles/audio).
 *  3. Otherwise, the file's own default, otherwise the first track.
 *
 * Within a chosen language (steps 1 and 2) the file's `isDefault` decides,
 * then stream order. That matters on remuxes, which carry the SAME language
 * several times at different qualities (TrueHD 7.1, AC3 5.1, AC3 stereo) —
 * picking merely the first match there would quietly demote the good mix.
 */
export function resolveInitialAudio<T extends AudioCandidate>(tracks: T[]): T | null {
  if (tracks.length === 0) return null;

  const bestInFamily = (family: string): T | null => {
    let best: T | null = null;
    for (const track of tracks) {
      if (languageFamily(track.language) !== family) continue;
      if (!best) {
        best = track;
        continue;
      }
      if (track.isDefault !== best.isDefault) {
        if (track.isDefault) best = track;
        continue;
      }
      if (track.index < best.index) best = track;
    }
    return best;
  };

  const pref = getAudioPreference();
  if (pref !== null) {
    const match = bestInFamily(pref);
    if (match) return match;
    // Saved family has no matching track in this file - fall through to AUTO.
  }

  const spanish = bestInFamily('es');
  if (spanish) return spanish;

  return tracks.find((track) => track.isDefault) ?? tracks[0] ?? null;
}
