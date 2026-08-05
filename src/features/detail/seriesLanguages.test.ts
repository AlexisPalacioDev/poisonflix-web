import { describe, expect, it } from 'vitest';
import type { SeriesEpisode } from '../../hooks/useSeriesEpisodes';
import { seriesAudioLanguagesOf, seriesSubtitleLanguagesOf } from './seriesLanguages';

// Per-series language coverage (owner ask #4 / live Bleach repro): the
// media-languages panel used to source a SERIES' language chips from a
// single episode's Jellyfin item (a Series item itself carries no
// MediaStreams) and present that one file's languages as the whole series'.
// Bleach: 95 episodes, 71 with an embedded Spanish subtitle, 24 without - the
// owner read a bare "Español" chip (sourced from one episode that happened to
// have it) and concluded the OPPOSITE of the truth. These helpers aggregate
// over every episode's own `mediaStreams` (already carried per-episode by
// `useSeriesEpisodes.ts`) so the panel can show real coverage instead.

function ep(overrides: Partial<SeriesEpisode> & Pick<SeriesEpisode, 'seasonNumber' | 'episodeNumber'>): SeriesEpisode {
  return {
    title: `E${overrides.episodeNumber}`,
    overview: null,
    stillUrl: null,
    status: { kind: 'Missing' },
    mediaStreams: null,
    ...overrides,
  };
}

function streams(...entries: Array<{ type: 'Audio' | 'Subtitle'; lang: string }>): unknown[] {
  return entries.map(({ type, lang }) => ({ Type: type, Language: lang }));
}

describe('seriesAudioLanguagesOf / seriesSubtitleLanguagesOf (per-series language coverage)', () => {
  it('counts a language against the FULL episode count, not just the episodes that have it (Bleach repro: 71 of 95)', () => {
    const episodes: SeriesEpisode[] = [
      ...Array.from({ length: 71 }, (_, i) =>
        ep({
          seasonNumber: 1,
          episodeNumber: i + 1,
          mediaStreams: streams({ type: 'Audio', lang: 'jpn' }, { type: 'Subtitle', lang: 'spa' }),
        }),
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ep({
          seasonNumber: 1,
          episodeNumber: 71 + i + 1,
          mediaStreams: streams({ type: 'Audio', lang: 'jpn' }),
        }),
      ),
    ];

    const subtitles = seriesSubtitleLanguagesOf(episodes);

    expect(subtitles).toEqual([{ label: 'Español', count: 71, total: 95 }]);
  });

  it('an episode with no mediaStreams at all (not yet downloaded) contributes to the total but never to any language count', () => {
    const episodes: SeriesEpisode[] = [
      ep({ seasonNumber: 1, episodeNumber: 1, mediaStreams: streams({ type: 'Subtitle', lang: 'spa' }) }),
      ep({ seasonNumber: 1, episodeNumber: 2, mediaStreams: null }),
      ep({ seasonNumber: 1, episodeNumber: 3, mediaStreams: null }),
    ];

    expect(seriesSubtitleLanguagesOf(episodes)).toEqual([{ label: 'Español', count: 1, total: 3 }]);
  });

  it('a language present on every episode reports full coverage (count === total)', () => {
    const episodes: SeriesEpisode[] = [
      ep({ seasonNumber: 1, episodeNumber: 1, mediaStreams: streams({ type: 'Audio', lang: 'jpn' }) }),
      ep({ seasonNumber: 1, episodeNumber: 2, mediaStreams: streams({ type: 'Audio', lang: 'jpn' }) }),
    ];

    expect(seriesAudioLanguagesOf(episodes)).toEqual([{ label: 'Japonés', count: 2, total: 2 }]);
  });

  it('multiple tracks of the same language within one episode count that episode once, not once per track', () => {
    const episodes: SeriesEpisode[] = [
      ep({
        seasonNumber: 1,
        episodeNumber: 1,
        mediaStreams: streams({ type: 'Subtitle', lang: 'spa' }, { type: 'Subtitle', lang: 'esp' }),
      }),
    ];

    expect(seriesSubtitleLanguagesOf(episodes)).toEqual([{ label: 'Español', count: 1, total: 1 }]);
  });

  it('sorts by coverage, most-covered language first', () => {
    const episodes: SeriesEpisode[] = [
      ep({ seasonNumber: 1, episodeNumber: 1, mediaStreams: streams({ type: 'Subtitle', lang: 'eng' }, { type: 'Subtitle', lang: 'spa' }) }),
      ep({ seasonNumber: 1, episodeNumber: 2, mediaStreams: streams({ type: 'Subtitle', lang: 'spa' }) }),
    ];

    expect(seriesSubtitleLanguagesOf(episodes).map((c) => c.label)).toEqual(['Español', 'Inglés']);
  });

  it('an empty episode list yields no languages, no throw', () => {
    expect(seriesAudioLanguagesOf([])).toEqual([]);
    expect(seriesSubtitleLanguagesOf([])).toEqual([]);
  });

  it('ignores malformed stream entries instead of throwing', () => {
    const episodes: SeriesEpisode[] = [
      ep({ seasonNumber: 1, episodeNumber: 1, mediaStreams: [null, 'not-an-object', { Type: 'Subtitle' }] }),
    ];

    expect(seriesSubtitleLanguagesOf(episodes)).toEqual([]);
  });
});
