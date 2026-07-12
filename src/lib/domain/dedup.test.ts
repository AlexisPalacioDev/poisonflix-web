import { describe, expect, it } from 'vitest';
import { distinctBy } from './dedup';

describe('distinctBy', () => {
  it('collapses duplicate keys to one entry, keeping first occurrence (search spec: duplicate TMDB ids collapse to one)', () => {
    const items = [
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 1, title: 'First (duplicate)' },
    ];

    const result = distinctBy(items, (item) => item.id);

    expect(result).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
    ]);
  });

  it('returns an empty array unchanged', () => {
    expect(distinctBy<{ id: number }, number>([], (item) => item.id)).toEqual([]);
  });

  it('returns all items unchanged when every key is already unique', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(distinctBy(items, (item) => item.id)).toEqual(items);
  });
});
