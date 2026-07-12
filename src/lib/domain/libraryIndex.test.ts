import { describe, expect, it } from 'vitest';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { jellyseerrStatusLabel, LibraryIndex, statusFromJellyseerrStatus } from './libraryIndex';

function item(overrides: Partial<JellyfinItem> & { Id: string; Name: string }): JellyfinItem {
  return overrides as JellyfinItem;
}

describe('LibraryIndex.resolve', () => {
  it('resolves InLibrary via primary TMDB-id match', () => {
    const index = new LibraryIndex([
      item({ Id: 'jf-1', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } }),
    ]);

    const status = index.resolve(603, 'The Matrix', 1999, null);

    expect(status).toEqual({ kind: 'InLibrary', jellyfinItemId: 'jf-1', matchedByFallback: false });
  });

  it('resolves InLibrary via fallback title+year match when no TMDB id is present', () => {
    const index = new LibraryIndex([
      item({ Id: 'jf-2', Name: 'The Matrix', ProductionYear: 1999 }),
    ]);

    const status = index.resolve(603, 'The Matrix', 1999, null);

    expect(status).toEqual({ kind: 'InLibrary', jellyfinItemId: 'jf-2', matchedByFallback: true });
  });

  it('fallback match is case-insensitive and trims whitespace', () => {
    const index = new LibraryIndex([
      item({ Id: 'jf-3', Name: '  The Matrix  ', ProductionYear: 1999 }),
    ]);

    const status = index.resolve(603, 'the matrix', 1999, null);

    expect(status).toEqual({ kind: 'InLibrary', jellyfinItemId: 'jf-3', matchedByFallback: true });
  });

  it('resolves Requesting when neither library match applies but an active request exists', () => {
    const index = new LibraryIndex([]);

    const status = index.resolve(27205, 'Inception', 2010, 3);

    expect(status).toEqual({ kind: 'Requesting', jellyseerrStatus: 3 });
  });

  it('resolves Requestable when neither a library match nor an active request exists', () => {
    const index = new LibraryIndex([]);

    const status = index.resolve(27205, 'Inception', 2010, null);

    expect(status).toEqual({ kind: 'Requestable' });
  });

  it('resolves Requestable when Jellyseerr status is AVAILABLE(5) but no Jellyfin item matched (correlation drift belt-and-suspenders)', () => {
    const index = new LibraryIndex([]);

    const status = index.resolve(27205, 'Inception', 2010, 5);

    expect(status).toEqual({ kind: 'Requestable' });
  });

  it('primary TMDB-id match takes precedence over the fallback title+year match', () => {
    const index = new LibraryIndex([
      item({ Id: 'jf-primary', Name: 'Some Other Title', ProviderIds: { Tmdb: '603' } }),
      item({ Id: 'jf-fallback', Name: 'The Matrix', ProductionYear: 1999 }),
    ]);

    const status = index.resolve(603, 'The Matrix', 1999, null);

    expect(status).toEqual({ kind: 'InLibrary', jellyfinItemId: 'jf-primary', matchedByFallback: false });
  });
});

describe('statusFromJellyseerrStatus (detail-request spec: reflect response.media.status)', () => {
  it('maps null to Requestable (no Jellyseerr media record yet)', () => {
    expect(statusFromJellyseerrStatus(null)).toEqual({ kind: 'Requestable' });
  });

  it('maps AVAILABLE(5) to Requestable, mirroring LibraryIndex.resolve\'s own belt-and-suspenders rule', () => {
    expect(statusFromJellyseerrStatus(5)).toEqual({ kind: 'Requestable' });
  });

  it.each([2, 3, 4])('maps status %i to Requesting, carrying the raw status through', (status) => {
    expect(statusFromJellyseerrStatus(status)).toEqual({ kind: 'Requesting', jellyseerrStatus: status });
  });
});

describe('jellyseerrStatusLabel', () => {
  it.each([
    [2, 'Pendiente'],
    [3, 'Descargando'],
    [4, 'Parcialmente disponible'],
    [5, 'Disponible'],
    [1, 'Descargando'],
  ])('maps status %i to %s', (status, label) => {
    expect(jellyseerrStatusLabel(status)).toBe(label);
  });
});
