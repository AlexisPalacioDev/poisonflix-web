import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAudioPreference,
  clearSubtitlePreference,
  getSubtitlePreference,
  resolveInitialAudio,
  resolveInitialSubtitle,
  setAudioPreference,
  setSubtitlePreference,
  SUBTITLE_OFF,
  subtitlePreferenceKeyFor,
  type AudioCandidate,
  type SubtitleCandidate,
} from './playerPrefs';

afterEach(() => {
  clearSubtitlePreference();
  clearAudioPreference();
});

describe('subtitle preference get/set', () => {
  it('returns null when nothing has been saved', () => {
    expect(getSubtitlePreference()).toBeNull();
  });

  it('round-trips a saved language family', () => {
    setSubtitlePreference('es');
    expect(getSubtitlePreference()).toBe('es');
  });

  it('round-trips the SUBTITLE_OFF sentinel', () => {
    setSubtitlePreference(SUBTITLE_OFF);
    expect(getSubtitlePreference()).toBe(SUBTITLE_OFF);
  });

  it('clearSubtitlePreference resets back to "never set" (null)', () => {
    setSubtitlePreference('en');
    clearSubtitlePreference();
    expect(getSubtitlePreference()).toBeNull();
  });
});

describe('subtitlePreferenceKeyFor', () => {
  it('returns SUBTITLE_OFF for "Ninguno" (null track)', () => {
    expect(subtitlePreferenceKeyFor(null)).toBe(SUBTITLE_OFF);
  });

  it('returns the language family when the track has a known language', () => {
    expect(subtitlePreferenceKeyFor({ language: 'spa', displayTitle: 'Español (forzado)' })).toBe('es');
  });

  it('falls back to the display title when language is unknown', () => {
    expect(subtitlePreferenceKeyFor({ language: null, displayTitle: 'Comentarios' })).toBe('Comentarios');
  });
});

const spanishTrack: SubtitleCandidate = { index: 2, language: 'spa', isDefault: false, isForced: false };
const englishTrack: SubtitleCandidate = { index: 1, language: 'eng', isDefault: true, isForced: false };
const englishForced: SubtitleCandidate = { index: 3, language: 'eng', isDefault: false, isForced: true };

describe('resolveInitialSubtitle — AUTO rule (player spec §8)', () => {
  it('turns subtitles ON in the app language when the default audio is NOT in that language', () => {
    const result = resolveInitialSubtitle([spanishTrack, englishTrack], 'eng', 'es');
    expect(result).toBe(spanishTrack);
  });

  it('leaves subtitles OFF when the default audio already matches the app language', () => {
    const result = resolveInitialSubtitle([spanishTrack, englishTrack], 'spa', 'es');
    expect(result).toBeNull();
  });

  it('returns null when there are no subtitle tracks at all', () => {
    expect(resolveInitialSubtitle([], 'eng', 'es')).toBeNull();
  });

  it('prefers the default, non-forced track within the matched family', () => {
    // App language 'en' + Spanish audio -> AUTO picks the best English
    // track between a forced one and the default, non-forced one.
    const result = resolveInitialSubtitle([englishForced, englishTrack], 'spa', 'en');
    expect(result).toBe(englishTrack);
  });
});

describe('resolveInitialSubtitle — saved preference wins over AUTO', () => {
  it('honors a saved SUBTITLE_OFF preference even when AUTO would turn subtitles on', () => {
    setSubtitlePreference(SUBTITLE_OFF);
    const result = resolveInitialSubtitle([spanishTrack, englishTrack], 'eng', 'es');
    expect(result).toBeNull();
  });

  it('honors a saved language-family preference over the AUTO rule', () => {
    setSubtitlePreference('en');
    // AUTO would pick Spanish here (audio is Spanish... wait: audio matches
    // app language 'es', so AUTO would turn subtitles OFF) - the saved 'en'
    // preference should still win and select the English track.
    const result = resolveInitialSubtitle([spanishTrack, englishTrack], 'spa', 'es');
    expect(result).toBe(englishTrack);
  });

  it('falls through to the AUTO rule when the saved preference has no matching track', () => {
    setSubtitlePreference('fre');
    const result = resolveInitialSubtitle([spanishTrack, englishTrack], 'eng', 'es');
    expect(result).toBe(spanishTrack);
  });
});

describe('resolveInitialSubtitle — forced vs. non-forced Spanish candidates', () => {
  it('prefers the non-forced Spanish track over a forced one (forced tracks only carry signs/dialogue, not the whole film)', () => {
    const spanishForced: SubtitleCandidate = { index: 6, language: 'spa', isDefault: false, isForced: true };
    const spanishFull: SubtitleCandidate = { index: 7, language: 'spa', isDefault: false, isForced: false };
    // Audio in English -> AUTO turns Spanish subtitles on; among the two
    // Spanish candidates the non-forced one must win.
    const result = resolveInitialSubtitle([spanishForced, spanishFull], 'eng', 'es');
    expect(result).toBe(spanishFull);
  });
});

const audioSpanish: AudioCandidate = { index: 2, language: 'spa', isDefault: false };
const audioEnglishDefault: AudioCandidate = { index: 1, language: 'eng', isDefault: true };
const audioLatino: AudioCandidate = { index: 3, language: 'lat', isDefault: false };

describe('resolveInitialAudio — Spanish must never be silently skipped (AUTO rule)', () => {
  it('prefers Spanish audio over the file\'s own default when no preference is saved', () => {
    const result = resolveInitialAudio([audioEnglishDefault, audioSpanish]);
    expect(result).toBe(audioSpanish);
  });

  it('recognizes Latin-American Spanish ("lat") as Spanish too', () => {
    const result = resolveInitialAudio([audioEnglishDefault, audioLatino]);
    expect(result).toBe(audioLatino);
  });

  it('falls back to the file default when there is no Spanish audio track at all (unchanged behavior)', () => {
    const audioFrench: AudioCandidate = { index: 4, language: 'fre', isDefault: false };
    const result = resolveInitialAudio([audioEnglishDefault, audioFrench]);
    expect(result).toBe(audioEnglishDefault);
  });

  it('among several Spanish candidates, prefers the one marked default, then the lowest index', () => {
    const spanishDefault: AudioCandidate = { index: 5, language: 'esp', isDefault: true };
    const result = resolveInitialAudio([audioEnglishDefault, audioSpanish, spanishDefault]);
    expect(result).toBe(spanishDefault);
  });

  it('a saved preference wins over the automatic Spanish rule', () => {
    setAudioPreference('en');
    const result = resolveInitialAudio([audioEnglishDefault, audioSpanish]);
    expect(result).toBe(audioEnglishDefault);
  });

  it('falls through to the Spanish AUTO rule when the saved preference has no matching track in this file', () => {
    setAudioPreference('fre');
    const result = resolveInitialAudio([audioEnglishDefault, audioSpanish]);
    expect(result).toBe(audioSpanish);
  });

  it('returns null when there are no audio tracks at all', () => {
    expect(resolveInitialAudio([])).toBeNull();
  });
});
