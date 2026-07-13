import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLanguage,
  setLanguage,
  subscribeLanguage,
  tmdbLanguageParam,
  toggleLanguage,
} from './languageSettings';

describe('languageSettings', () => {
  afterEach(() => {
    localStorage.removeItem('poisonflix:language');
  });

  it('defaults to "es" when nothing is persisted', () => {
    expect(getLanguage()).toBe('es');
  });

  it('setLanguage persists the choice so a later getLanguage reflects it', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
  });

  it('toggleLanguage flips es -> en -> es and persists each flip', () => {
    expect(getLanguage()).toBe('es');

    expect(toggleLanguage()).toBe('en');
    expect(getLanguage()).toBe('en');

    expect(toggleLanguage()).toBe('es');
    expect(getLanguage()).toBe('es');
  });

  it('tmdbLanguageParam maps "es" to "es-MX" and "en" to "en"', () => {
    expect(tmdbLanguageParam('es')).toBe('es-MX');
    expect(tmdbLanguageParam('en')).toBe('en');
  });

  it('tmdbLanguageParam with no argument reads the current persisted language', () => {
    setLanguage('en');
    expect(tmdbLanguageParam()).toBe('en');

    setLanguage('es');
    expect(tmdbLanguageParam()).toBe('es-MX');
  });

  it('subscribeLanguage fires with the new language on every toggle/set', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLanguage(listener);

    toggleLanguage();
    expect(listener).toHaveBeenCalledWith('en');

    setLanguage('es');
    expect(listener).toHaveBeenCalledWith('es');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    toggleLanguage();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
