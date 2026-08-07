import { describe, expect, it } from 'vitest';
import {
  buildFeedRows,
  excludePlayed,
  interleave,
  pickPlaySeeds,
  pickSeedTracks,
  trackArtist,
} from './musicTaste';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicPlay, MusicSongResult } from '../../api/schemas/music';

function played(id: string, artist: string | null): JellyfinItem {
  return { Id: id, Name: `Track ${id}`, Artists: artist ? [artist] : [] } as JellyfinItem;
}

function play(overrides: Partial<MusicPlay> & { videoId: string }): MusicPlay {
  return { count: 1, title: '', artist: '', seconds: 0, ...overrides };
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

describe('pickPlaySeeds', () => {
  it('seeds from real streaming plays, one per artist, in the order given', () => {
    // NOT "most-played first": `pickPlaySeeds` does no sorting of its own —
    // it just keeps the first play per distinct artist in whatever order the
    // caller handed it. Ordering by play count is the worker's job
    // (`server.py:401`), not this function's; this test only pins the
    // one-per-artist filtering, using an already-sorted input.
    const plays = [
      play({ videoId: 'v1', artist: 'Brutalismus', title: 'Song 1', count: 9 }),
      play({ videoId: 'v2', artist: 'Brutalismus', title: 'Song 2', count: 7 }),
      play({ videoId: 'v3', artist: 'Canserbero', title: 'Song 3', count: 5 }),
      play({ videoId: 'v4', artist: 'Zapravka', title: 'Song 4', count: 3 }),
    ];

    const seeds = pickPlaySeeds(plays);

    expect(seeds).toEqual([
      { id: 'v1', label: 'Brutalismus' },
      { id: 'v3', label: 'Canserbero' },
      { id: 'v4', label: 'Zapravka' },
    ]);
  });

  it('matches artists case-insensitively', () => {
    const seeds = pickPlaySeeds([
      play({ videoId: 'a', artist: 'The Band' }),
      play({ videoId: 'b', artist: 'the band' }),
    ]);
    expect(seeds).toHaveLength(1);
  });

  it('falls back to the title when the artist is missing', () => {
    const seeds = pickPlaySeeds([play({ videoId: 'a', artist: '', title: 'Lonely Track' })]);
    expect(seeds).toEqual([{ id: 'a', label: 'Lonely Track' }]);
  });

  it('discards a play with neither artist nor title — no honest label to show', () => {
    const seeds = pickPlaySeeds([
      play({ videoId: 'unlabelled', artist: '', title: '' }),
      play({ videoId: 'ok', artist: 'Real Artist', title: 'Real Title' }),
    ]);
    expect(seeds).toEqual([{ id: 'ok', label: 'Real Artist' }]);
  });

  it('honours the seed cap', () => {
    const plays = ['a', 'b', 'c', 'd', 'e'].map((id) => play({ videoId: id, artist: id }));
    expect(pickPlaySeeds(plays)).toHaveLength(3);
    expect(pickPlaySeeds(plays, 2)).toHaveLength(2);
  });

  it('returns nothing for an empty play history — the cold-start signal', () => {
    expect(pickPlaySeeds([])).toEqual([]);
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

  it('drops a seed row that repeats an earlier row\'s exact tracklist — the reported "same five songs" bug', () => {
    const rows = buildFeedRows(seeds, [[song('a1'), song('a2')], [song('a1'), song('a2')]], 'history', 10);
    expect(rows.map((r) => r.key)).toEqual(['mix', 'seed-s1']);
  });

  it('keeps two seed rows whose tracklists merely overlap, not match exactly', () => {
    // This guards a genuinely narrow case now: `perSeed` here is meant to be
    // PURE (seed + related only, mobile-music-overhaul fix-seeded-rows) data,
    // where two different seeds sharing a couple of genre-adjacent tracks is
    // an occasional coincidence, not the everyday case it used to be when
    // three of five sources were user-global and therefore identical across
    // every seed. The dedup rule itself is unchanged — only exact, full-list
    // duplicates collapse — this test just documents why that is now rare.
    const rows = buildFeedRows(
      seeds,
      [[song('a1'), song('a2')], [song('a1'), song('b2')]],
      'history',
      10,
    );
    expect(rows.map((r) => r.key)).toEqual(['mix', 'seed-s1', 'seed-s2']);
  });

  it('mixes from a separate, fully-personalised source while each seed row stays seed-only', () => {
    // mobile-music-overhaul fix-seeded-rows: "Porque escuchaste X" rows must
    // use ONLY seed-dependent data (the worker's `pure` mode) so two
    // different seeds never share the three sources that used to be
    // identical for every seed of the same user. "Mix para vos" is the
    // opposite: it is SUPPOSED to blend in everything, including the
    // user-global sources — that personalisation is correct and desired
    // there. So `buildFeedRows` takes the two data sets separately: `perSeed`
    // (pure) builds each "Porque escuchaste" row, and the optional 5th
    // argument (full, default-mode data) builds the mix. Omitting the 5th
    // argument falls back to `perSeed` for both, which is what every other
    // test in this file relies on.
    const pureOnly = [[song('pure-a1')], [song('pure-b1')]];
    const fullyPersonalised = [
      [song('pure-a1'), song('global-artist-track')],
      [song('pure-b1'), song('global-artist-track')],
    ];

    const rows = buildFeedRows(seeds, pureOnly, 'history', 10, fullyPersonalised);

    const mix = rows.find((r) => r.key === 'mix');
    expect(mix?.items.map((i) => i.videoId)).toContain('global-artist-track');

    const rowOne = rows.find((r) => r.key === 'seed-s1');
    const rowTwo = rows.find((r) => r.key === 'seed-s2');
    expect(rowOne?.items.map((i) => i.videoId)).toEqual(['pure-a1']);
    expect(rowTwo?.items.map((i) => i.videoId)).toEqual(['pure-b1']);
  });

  it('leads the mix with tracks no seed row is already showing', () => {
    // Measured on the running app before this rule existed: "Mix para vos"
    // shared 6/12, 5/12 and 5/12 tracks with the three "Porque escuchaste"
    // rows below it, and its FIRST card was the same track as the first card
    // of the row directly underneath. That is the residue of the reported
    // "every row shows the same five songs" bug: the per-seed rows were fixed
    // by the worker's `pure` mode, but the mix still draws from the same
    // seeds, so it echoed each row's opening track straight back.
    //
    // The mix is still allowed to repeat — it is a blend of these same
    // radios, so forbidding it outright would starve it. It just may not LEAD
    // with the echo while unseen tracks are sitting behind it.
    const pureOnly = [
      [song('a1'), song('a2')],
      [song('b1'), song('b2')],
    ];
    const fullyPersonalised = [
      [song('a1'), song('a2'), song('fresh-a')],
      [song('b1'), song('b2'), song('fresh-b')],
    ];

    const rows = buildFeedRows(seeds, pureOnly, 'history', 4, fullyPersonalised);
    const mix = rows.find((r) => r.key === 'mix');

    expect(mix?.items.slice(0, 2).map((i) => i.videoId)).toEqual(['fresh-a', 'fresh-b']);
  });

  it('still fills the mix to the limit when every track is already in a seed row', () => {
    // The preference must not become an exclusion: a user whose radios return
    // nothing beyond what the seed rows show would otherwise get a mix with a
    // couple of tracks in it, or none at all.
    const both = [
      [song('a1'), song('a2')],
      [song('b1'), song('b2')],
    ];

    const rows = buildFeedRows(seeds, both, 'history', 4, both);
    const mix = rows.find((r) => r.key === 'mix');

    expect(mix?.items).toHaveLength(4);
  });
});
