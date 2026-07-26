import { describe, expect, it } from 'vitest';
import {
  buildFeedRows,
  excludePlayed,
  interleave,
  pickSeedTracks,
  trackArtist,
} from './musicTaste';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicSongResult } from '../../api/schemas/music';

function played(id: string, artist: string | null): JellyfinItem {
  return { Id: id, Name: `Track ${id}`, Artists: artist ? [artist] : [] } as JellyfinItem;
}

function song(videoId: string, jellyfinItemId: string | null = null): MusicSongResult {
  return {
    type: 'song',
    videoId,
    title: `Song ${videoId}`,
    artist: null,
    artists: [],
    album: null,
    durationSeconds: null,
    thumbnailUrl: null,
    source: 'ytmusic',
    genre: null,
    downloaded: Boolean(jellyfinItemId),
    jellyfinItemId,
  } as MusicSongResult;
}

describe('trackArtist', () => {
  it('prefers the credited artist and falls back to the album artist', () => {
    expect(trackArtist(played('1', 'The Band'))).toBe('The Band');
    expect(trackArtist({ Id: '2', Name: 'x', AlbumArtist: 'Solo' } as JellyfinItem)).toBe('Solo');
    expect(trackArtist({ Id: '3', Name: 'x' } as JellyfinItem)).toBeNull();
  });
});

describe('pickSeedTracks', () => {
  it('spreads the seeds across artists instead of stacking one on repeat', () => {
    const seeds = pickSeedTracks([
      played('a1', 'Brutalismus'),
      played('a2', 'Brutalismus'),
      played('a3', 'Brutalismus'),
      played('b1', 'Canserbero'),
      played('c1', 'Zapravka'),
    ]);
    expect(seeds.map((s) => s.Id)).toEqual(['a1', 'b1', 'c1']);
  });

  it('matches artists case-insensitively — Jellyfin credits are not normalised', () => {
    const seeds = pickSeedTracks([played('a', 'The Band'), played('b', 'the band')]);
    expect(seeds).toHaveLength(1);
  });

  it('keeps artist-less tracks rather than dropping a user\'s only history', () => {
    const seeds = pickSeedTracks([played('a', null), played('b', null)]);
    expect(seeds.map((s) => s.Id)).toEqual(['a', 'b']);
  });

  it('honours the seed cap', () => {
    const history = ['a', 'b', 'c', 'd', 'e'].map((id) => played(id, id));
    expect(pickSeedTracks(history)).toHaveLength(3);
    expect(pickSeedTracks(history, 2)).toHaveLength(2);
  });

  it('returns nothing for an empty history — the cold-start signal', () => {
    expect(pickSeedTracks([])).toEqual([]);
  });
});

describe('interleave', () => {
  it('round-robins the rows so every taste shows up near the top', () => {
    const mixed = interleave(
      [
        [song('a1'), song('a2')],
        [song('b1'), song('b2')],
      ],
      10,
    );
    expect(mixed.map((s) => s.videoId)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('drops a track that two radios both suggested', () => {
    const mixed = interleave([[song('same')], [song('same'), song('other')]], 10);
    expect(mixed.map((s) => s.videoId)).toEqual(['same', 'other']);
  });

  it('keeps going through rows of uneven length', () => {
    const mixed = interleave([[song('a1')], [song('b1'), song('b2'), song('b3')]], 10);
    expect(mixed.map((s) => s.videoId)).toEqual(['a1', 'b1', 'b2', 'b3']);
  });

  it('respects the limit', () => {
    expect(interleave([[song('a'), song('b'), song('c')]], 2)).toHaveLength(2);
  });

  it('handles no rows at all', () => {
    expect(interleave([], 5)).toEqual([]);
  });
});

describe('excludePlayed', () => {
  it('drops what the user already played, keeping what they have not', () => {
    const kept = excludePlayed([song('a', 'item-1'), song('b', 'item-2')], new Set(['item-1']));
    expect(kept.map((s) => s.videoId)).toEqual(['b']);
  });

  it('keeps tracks that are not in the library at all — nothing to have played', () => {
    const kept = excludePlayed([song('a'), song('b')], new Set(['item-1']));
    expect(kept).toHaveLength(2);
  });
});

describe('buildFeedRows', () => {
  const seeds = [
    { id: 's1', label: 'Métricas Frías' },
    { id: 's2', label: 'Alcolirykoz' },
  ];
  const perSeed = [
    [song('a1'), song('a2')],
    [song('b1')],
  ];

  it('names a history row after the artist, so the row explains itself', () => {
    const rows = buildFeedRows(seeds, perSeed, 'history', 10);
    expect(rows[0].title).toBe('Mix para vos');
    expect(rows.map((r) => r.title)).toContain('Porque escuchaste Métricas Frías');
  });

  it('never claims "porque escuchaste" for library seeds — they were not played', () => {
    const rows = buildFeedRows(seeds, perSeed, 'library', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Basado en tu biblioteca');
    expect(rows.some((r) => r.title.includes('escuchaste'))).toBe(false);
  });

  it('drops a seed whose radio came back empty instead of rendering a blank row', () => {
    const rows = buildFeedRows(seeds, [[song('a1')], []], 'history', 10);
    expect(rows.map((r) => r.key)).toEqual(['mix', 'seed-s1']);
  });

  it('returns no rows at all when every radio is empty', () => {
    expect(buildFeedRows(seeds, [[], []], 'history', 10)).toEqual([]);
  });

  it('caps the mix', () => {
    const rows = buildFeedRows(seeds, perSeed, 'history', 2);
    expect(rows[0].items).toHaveLength(2);
  });
});
