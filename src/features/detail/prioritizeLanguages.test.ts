import { describe, expect, it } from 'vitest';
import { prioritizeLanguages } from './prioritizeLanguages';

describe('prioritizeLanguages', () => {
  it('orders app language (Español) first, then Inglés, then the file default, then the rest', () => {
    const { shown } = prioritizeLanguages(
      ['Alemán', 'Inglés', 'Francés', 'Español', 'Japonés'],
      'Francés',
    );
    expect(shown).toEqual(['Español', 'Inglés', 'Francés', 'Alemán', 'Japonés']);
  });

  it('deduplicates when the default equals Español or Inglés', () => {
    const { shown } = prioritizeLanguages(['Español', 'Inglés', 'Alemán'], 'Español');
    expect(shown).toEqual(['Español', 'Inglés', 'Alemán']);
  });

  it('ignores a default that is not present in the list', () => {
    const { shown } = prioritizeLanguages(['Alemán', 'Italiano'], 'Coreano');
    expect(shown).toEqual(['Alemán', 'Italiano']);
  });

  it('handles a null default', () => {
    const { shown } = prioritizeLanguages(['Inglés', 'Español'], null);
    expect(shown).toEqual(['Español', 'Inglés']);
  });

  it('collapses a long list behind the limit, preserving priority order in "shown"', () => {
    const labels = [
      'Alemán', 'Italiano', 'Español', 'Inglés', 'Francés', 'Japonés',
      'Coreano', 'Chino', 'Ruso', 'Árabe', 'Neerlandés', 'Checo',
      'Danés', 'Griego', 'Finés', 'Húngaro', 'Noruego', 'Polaco',
      'Rumano', 'Eslovaco', 'Sueco', 'Turco', 'Hebreo', 'Hindi',
    ];
    const { shown, hidden } = prioritizeLanguages(labels, 'Francés', 4);
    expect(shown).toEqual(['Español', 'Inglés', 'Francés', 'Alemán']);
    expect(shown).toHaveLength(4);
    expect(hidden).toHaveLength(20);
    expect(hidden).not.toContain('Español');
    expect(hidden).not.toContain('Inglés');
    expect(hidden).not.toContain('Francés');
  });

  it('leaves hidden empty when the list fits within the limit', () => {
    const { hidden } = prioritizeLanguages(['Español', 'Inglés', 'Alemán'], null, 4);
    expect(hidden).toEqual([]);
  });

  it('defaults the limit to 6 when not provided', () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const { shown, hidden } = prioritizeLanguages(labels, null);
    expect(shown).toHaveLength(6);
    expect(hidden).toEqual(['G']);
  });
});
