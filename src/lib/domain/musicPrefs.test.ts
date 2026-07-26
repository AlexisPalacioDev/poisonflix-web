import { afterEach, describe, expect, it } from 'vitest';
import { getAutoplayPreference, setAutoplayPreference } from './musicPrefs';

describe('autoplay preference', () => {
  afterEach(() => localStorage.clear());

  it('defaults to on, the way YouTube Music and Spotify ship it', () => {
    expect(getAutoplayPreference()).toBe(true);
  });

  it('round-trips an explicit opt-out', () => {
    setAutoplayPreference(false);
    expect(getAutoplayPreference()).toBe(false);
    setAutoplayPreference(true);
    expect(getAutoplayPreference()).toBe(true);
  });

  it('treats a junk stored value as on rather than silently killing playback', () => {
    localStorage.setItem('poisonflix:musicAutoplay', 'yes');
    expect(getAutoplayPreference()).toBe(true);
  });
});
