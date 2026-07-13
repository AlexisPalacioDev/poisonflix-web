import { describe, it, expect } from 'vitest';
import { detectLanguages } from './releaseLanguage';

describe('detectLanguages', () => {
  it('defaults an unmarked scene release to English', () => {
    expect(detectLanguages('Mr.Robot.S01.1080p.BluRay.x264-ROVERS')).toEqual(['english']);
  });

  it('detects Spanish from "Subtitulado Esp"', () => {
    expect(detectLanguages('Mr Robot S01E01 HDTV Subtitulado Esp SC')).toContain('spanish');
  });

  it('detects Latino as a Spanish variant, not generic Spanish', () => {
    const langs = detectLanguages('Pelicula 2015 1080p Dual Latino x265');
    expect(langs).toContain('spanish-latino');
    expect(langs).not.toContain('spanish');
  });

  it('detects Castellano distinctly from Latino', () => {
    expect(detectLanguages('Serie S01 Castellano 1080p')).toContain('spanish-castellano');
  });

  it('detects French VOSTFR', () => {
    expect(detectLanguages('Mr Robot S01 VOSTFR 1080p 10bit BluRay x265 NSP')).toContain('french');
  });

  it('detects a bilingual Italian/English release', () => {
    const langs = detectLanguages('Mr Robot S01e01[BDMux 720p H264 Ita Eng Ac3 Sub Ita Eng]');
    expect(langs).toContain('italian');
    expect(langs).toContain('english');
  });

  it('treats MULTI as including English', () => {
    const langs = detectLanguages('Silo S03E03 MULTI 1080p WEB H264-HiggsBoson');
    expect(langs).toContain('multi');
    expect(langs).toContain('english');
  });

  it('is deterministic in ordering (English first)', () => {
    expect(detectLanguages('Movie MULTI Latino English')[0]).toBe('english');
  });
});
