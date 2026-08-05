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

  it('resolves the previously-unmapped ISO 639-2 codes observed raw in the wild (detail-request spec)', () => {
    expect(languageDisplayName('ces', 'fallback')).toBe('Checo');
    expect(languageDisplayName('dan', 'fallback')).toBe('Danés');
    expect(languageDisplayName('ell', 'fallback')).toBe('Griego');
    expect(languageDisplayName('fin', 'fallback')).toBe('Finés');
    expect(languageDisplayName('hun', 'fallback')).toBe('Húngaro');
    expect(languageDisplayName('nor', 'fallback')).toBe('Noruego');
    expect(languageDisplayName('pol', 'fallback')).toBe('Polaco');
    expect(languageDisplayName('ron', 'fallback')).toBe('Rumano');
    expect(languageDisplayName('slk', 'fallback')).toBe('Eslovaco');
    expect(languageDisplayName('swe', 'fallback')).toBe('Sueco');
    expect(languageDisplayName('tur', 'fallback')).toBe('Turco');
  });

  it('also resolves the ISO 639-2/B alias codes for the same languages', () => {
    expect(languageDisplayName('cze', 'fallback')).toBe('Checo');
    expect(languageDisplayName('gre', 'fallback')).toBe('Griego');
    expect(languageDisplayName('rum', 'fallback')).toBe('Rumano');
    expect(languageDisplayName('slo', 'fallback')).toBe('Eslovaco');
  });

  it('still falls back for "und" (undetermined) after the table expansion', () => {
    expect(languageDisplayName('und', 'UND')).toBe('UND');
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
