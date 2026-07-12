import { describe, expect, it } from 'vitest';
import { JellyseerrRequestDtoSchema, JellyseerrSearchResponseSchema, JellyseerrUserSchema } from './jellyseerr';

describe('JellyseerrUserSchema', () => {
  it('parses a valid auth response user', () => {
    const fixture = { id: 1, jellyfinUsername: 'walter', permissions: 32 };
    const parsed = JellyseerrUserSchema.parse(fixture);
    expect(parsed.id).toBe(1);
    expect(parsed.jellyfinUsername).toBe('walter');
  });

  it('rejects a malformed user missing the required numeric id', () => {
    const malformed = { jellyfinUsername: 'walter' };
    expect(() => JellyseerrUserSchema.parse(malformed)).toThrow();
  });
});

describe('JellyseerrSearchResponseSchema', () => {
  it('parses a search result carrying mediaInfo', () => {
    const fixture = {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        {
          id: 603,
          mediaType: 'movie',
          title: 'The Matrix',
          releaseDate: '1999-03-30',
          mediaInfo: { id: 10, tmdbId: 603, status: 5 },
        },
      ],
    };

    const parsed = JellyseerrSearchResponseSchema.parse(fixture);
    expect(parsed.results[0].mediaInfo?.status).toBe(5);
  });

  it('parses a search result with no mediaInfo (first-time search hit)', () => {
    const fixture = {
      results: [{ id: 27205, mediaType: 'movie', title: 'Inception' }],
    };

    const parsed = JellyseerrSearchResponseSchema.parse(fixture);
    expect(parsed.results[0].mediaInfo).toBeUndefined();
    expect(parsed.totalResults).toBe(0);
  });

  it('rejects a result missing the required mediaType field', () => {
    const malformed = { results: [{ id: 603, title: 'The Matrix' }] };
    expect(() => JellyseerrSearchResponseSchema.parse(malformed)).toThrow();
  });
});

describe('JellyseerrRequestDtoSchema', () => {
  it('parses a request response, reading status from the nested media object', () => {
    const fixture = {
      id: 5,
      type: 'movie',
      status: 2,
      media: { id: 10, tmdbId: 603, status: 2 },
    };

    const parsed = JellyseerrRequestDtoSchema.parse(fixture);
    expect(parsed.media.status).toBe(2);
  });

  it('rejects a request response missing the required media object', () => {
    const malformed = { id: 5, type: 'movie', status: 2 };
    expect(() => JellyseerrRequestDtoSchema.parse(malformed)).toThrow();
  });
});
