import { describe, expect, it } from 'vitest';
import { languageDisplayName, languageFamily } from './languageNames';

describe('languageDisplayName', () => {
  it('maps Spanish codes to "Español"', () => {
    expect(languageDisplayName('es', 'fallback')).toBe('Español');
    expect(languageDisplayName('spa', 'fallback')).toBe('Español');
    expect(languageDisplayName('lat', 'fallback')).toBe('Español');
  });

  it('maps English codes to "Inglés"', () => {
    expect(languageDisplayName('en', 'fallback')).toBe('Inglés');
    expect(languageDisplayName('eng', 'fallback')).toBe('Inglés');
  });

  it('falls back sensibly for "und" (undetermined)', () => {
    expect(languageDisplayName('und', 'UND')).toBe('UND');
  });

  it('passes through the fallback for a completely unknown code', () => {
    expect(languageDisplayName('xx', 'Custom Label')).toBe('Custom Label');
  });

  it('falls back when the code is null/undefined', () => {
    expect(languageDisplayName(null, 'fallback')).toBe('fallback');
    expect(languageDisplayName(undefined, 'fallback')).toBe('fallback');
  });

  it('maps a handful of other common languages', () => {
    expect(languageDisplayName('fre', 'fallback')).toBe('Francés');
    expect(languageDisplayName('jpn', 'fallback')).toBe('Japonés');
    expect(languageDisplayName('kor', 'fallback')).toBe('Coreano');
  });
});

describe('languageFamily', () => {
  it('collapses Spanish variants to "es"', () => {
    expect(languageFamily('es')).toBe('es');
    expect(languageFamily('spa')).toBe('es');
    expect(languageFamily('lat')).toBe('es');
  });

  it('collapses English variants to "en"', () => {
    expect(languageFamily('en')).toBe('en');
    expect(languageFamily('eng')).toBe('en');
  });

  it('returns the lowercased 3-char code for unmapped languages', () => {
    expect(languageFamily('FRE')).toBe('fre');
  });

  it('returns null for null/empty input', () => {
    expect(languageFamily(null)).toBeNull();
    expect(languageFamily(undefined)).toBeNull();
    expect(languageFamily('')).toBeNull();
  });
});
