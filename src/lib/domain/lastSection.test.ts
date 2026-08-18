import { describe, expect, it, beforeEach } from 'vitest';
import { lastSection, rememberSection, sectionOf, SECTION_HOME } from './lastSection';

describe('lastSection', () => {
  beforeEach(() => window.localStorage.clear());

  it('returns the stored section', () => {
    rememberSection('juegos');
    expect(lastSection()).toBe('juegos');
  });

  it('falls back to cinema for an unknown value', () => {
    window.localStorage.setItem('poisonflix:lastSection', 'basura');
    expect(lastSection()).toBe('cine');
  });

  // `in` walks the prototype chain: without an own-key check these all pass as
  // sections, and SECTION_HOME[key] is then undefined.
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'does not accept the prototype key %s as a section',
    (key) => {
      window.localStorage.setItem('poisonflix:lastSection', key);
      const got = lastSection();
      expect(got).toBe('cine');
      expect(SECTION_HOME[got]).toBeDefined();
    },
  );

  it('classifies paths without swallowing shared pages', () => {
    expect(sectionOf('/')).toBe('cine');
    expect(sectionOf('/musica')).toBe('musica');
    expect(sectionOf('/musica/album/7')).toBe('musica');
    expect(sectionOf('/jam')).toBe('musica');
    expect(sectionOf('/juegos')).toBe('juegos');
    expect(sectionOf('/juegos/play/abc')).toBe('juegos');
    expect(sectionOf('/downloads')).toBeNull();
    // A path that merely starts with a section's letters is not that section.
    expect(sectionOf('/juegosdeayer')).toBeNull();
  });
});
