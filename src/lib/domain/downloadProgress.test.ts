import { describe, expect, it } from 'vitest';
import { buildProgressByTmdbId, type QueueResponseInput } from './downloadProgress';

const emptyQueue: QueueResponseInput = { records: [] };

describe('buildProgressByTmdbId', () => {
  it('correlates a Radarr queue record to a movie tmdbId and computes percent', () => {
    const radarrQueue: QueueResponseInput = {
      records: [{ movieId: 10, size: 1000, sizeleft: 250 }],
    };
    const radarrMovies = [{ id: 10, tmdbId: 603 }];

    const result = buildProgressByTmdbId(radarrQueue, radarrMovies, emptyQueue, []);

    expect(result.get(603)).toBe(75);
  });

  it('correlates a Sonarr queue record to a series tmdbId', () => {
    const sonarrQueue: QueueResponseInput = {
      records: [{ seriesId: 5, size: 2000, sizeleft: 1000 }],
    };
    const sonarrSeries = [{ id: 5, tmdbId: 1399 }];

    const result = buildProgressByTmdbId(emptyQueue, [], sonarrQueue, sonarrSeries);

    expect(result.get(1399)).toBe(50);
  });

  it('drops a Sonarr series with a null tmdbId (no TMDB match on this instance)', () => {
    const sonarrQueue: QueueResponseInput = {
      records: [{ seriesId: 5, size: 2000, sizeleft: 1000 }],
    };
    const sonarrSeries = [{ id: 5, tmdbId: null }];

    const result = buildProgressByTmdbId(emptyQueue, [], sonarrQueue, sonarrSeries);

    expect(result.size).toBe(0);
  });

  it('drops a queue record whose FK does not resolve to any known movie/series', () => {
    const radarrQueue: QueueResponseInput = {
      records: [{ movieId: 999, size: 1000, sizeleft: 250 }],
    };

    const result = buildProgressByTmdbId(radarrQueue, [{ id: 10, tmdbId: 603 }], emptyQueue, []);

    expect(result.size).toBe(0);
  });

  it('clamps percent to 0..100 and treats an unknown total size (0) as no percent', () => {
    const radarrQueue: QueueResponseInput = {
      records: [
        // sizeleft > size would only happen from a malformed record; still must clamp.
        { movieId: 1, size: 100, sizeleft: 150 },
        // size 0 -> percent unknown, must be dropped entirely (not treated as 0%).
        { movieId: 2, size: 0, sizeleft: 0 },
      ],
    };
    const radarrMovies = [
      { id: 1, tmdbId: 111 },
      { id: 2, tmdbId: 222 },
    ];

    const result = buildProgressByTmdbId(radarrQueue, radarrMovies, emptyQueue, []);

    expect(result.get(111)).toBe(0);
    expect(result.has(222)).toBe(false);
  });

  it('averages the percent per tmdbId across multiple queue records (matches the projector reference, e.g. several episodes of a series)', () => {
    const sonarrQueue: QueueResponseInput = {
      records: [
        { seriesId: 5, size: 1000, sizeleft: 800 }, // 20%
        { seriesId: 5, size: 1000, sizeleft: 100 }, // 90%
      ],
    };
    const sonarrSeries = [{ id: 5, tmdbId: 1399 }];

    const result = buildProgressByTmdbId(emptyQueue, [], sonarrQueue, sonarrSeries);

    // (20 + 90) / 2 = 55, truncated (Kotlin `.average().toInt()`), not MAX (90).
    expect(result.get(1399)).toBe(55);
  });

  it('merges Radarr and Sonarr correlations into a single map', () => {
    const radarrQueue: QueueResponseInput = { records: [{ movieId: 1, size: 100, sizeleft: 50 }] };
    const sonarrQueue: QueueResponseInput = { records: [{ seriesId: 5, size: 100, sizeleft: 25 }] };

    const result = buildProgressByTmdbId(
      radarrQueue,
      [{ id: 1, tmdbId: 603 }],
      sonarrQueue,
      [{ id: 5, tmdbId: 1399 }],
    );

    expect(result.get(603)).toBe(50);
    expect(result.get(1399)).toBe(75);
  });
});
