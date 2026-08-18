import { describe, expect, it } from 'vitest';
import { foldForSearch } from './searchText';

describe('foldForSearch', () => {
  it('makes an accented title reachable from an unaccented query', () => {
    expect(foldForSearch('Pokémon Edición Roja')).toBe('pokemon edicion roja');
    // The query folds through the same door, so the two meet.
    expect(foldForSearch('POKEMON')).toBe('pokemon');
  });

  it('folds marks it was never given a table for', () => {
    // The point of NFD over a hand-written map: nobody enumerated these.
    expect(foldForSearch('Ōkami')).toBe('okami');
    expect(foldForSearch('Grandía')).toBe('grandia');
    expect(foldForSearch('Mönster')).toBe('monster');
  });

  it('folds ñ to n, so "manana" still finds "mañana"', () => {
    // A deliberate consequence: ñ is its own letter in Spanish, but someone
    // filtering a shelf types the nearest key they have.
    expect(foldForSearch('Mañana')).toBe('manana');
  });

  it('trims, so a trailing space typed by accident still matches', () => {
    expect(foldForSearch('  Sonic ')).toBe('sonic');
  });

  it('leaves a string with nothing to fold untouched apart from case', () => {
    expect(foldForSearch('Chrono Trigger')).toBe('chrono trigger');
    expect(foldForSearch('')).toBe('');
  });
});
