import { describe, expect, it } from 'vitest';
import {
  JellyfinAuthResponseSchema,
  JellyfinItemSchema,
  JellyfinPlaybackInfoResponseSchema,
  JellyfinQueryResultSchema,
} from './jellyfin';

describe('JellyfinAuthResponseSchema', () => {
  it('parses a valid auth response', () => {
    const fixture = {
      User: { Id: 'user-1', Name: 'walter' },
      AccessToken: 'token-abc',
      ServerId: 'server-1',
    };

    const parsed = JellyfinAuthResponseSchema.parse(fixture);
    expect(parsed.AccessToken).toBe('token-abc');
    expect(parsed.User.Name).toBe('walter');
  });

  it('rejects a malformed auth response missing AccessToken', () => {
    const malformed = { User: { Id: 'user-1', Name: 'walter' }, ServerId: 'server-1' };
    expect(() => JellyfinAuthResponseSchema.parse(malformed)).toThrow();
  });
});

describe('JellyfinItemSchema / JellyfinQueryResultSchema', () => {
  it('parses a valid item with ProviderIds and optional fields absent', () => {
    const fixture = {
      Id: 'item-1',
      Name: 'The Matrix',
      ProductionYear: 1999,
      ProviderIds: { Imdb: 'tt0133093', Tmdb: '603' },
    };

    const parsed = JellyfinItemSchema.parse(fixture);
    expect(parsed.ProviderIds?.Tmdb).toBe('603');
    expect(parsed.Overview).toBeUndefined();
  });

  it('parses a query result envelope, defaulting missing counts to 0', () => {
    const fixture = { Items: [{ Id: 'item-1', Name: 'The Matrix' }] };
    const parsed = JellyfinQueryResultSchema.parse(fixture);

    expect(parsed.Items).toHaveLength(1);
    expect(parsed.TotalRecordCount).toBe(0);
  });

  it('rejects an item missing the required Id field', () => {
    const malformed = { Name: 'The Matrix' };
    expect(() => JellyfinItemSchema.parse(malformed)).toThrow();
  });
});

describe('JellyfinPlaybackInfoResponseSchema', () => {
  it('parses a DirectPlay-eligible media source (no TranscodingUrl)', () => {
    const fixture = {
      MediaSources: [
        {
          Id: 'src-1',
          Container: 'mkv',
          SupportsDirectPlay: true,
        },
      ],
      PlaySessionId: 'session-1',
    };

    const parsed = JellyfinPlaybackInfoResponseSchema.parse(fixture);
    expect(parsed.MediaSources[0].TranscodingUrl).toBeUndefined();
    expect(parsed.MediaSources[0].SupportsDirectPlay).toBe(true);
  });

  it('rejects a media source missing the required Id field', () => {
    const malformed = { MediaSources: [{ Container: 'mkv' }] };
    expect(() => JellyfinPlaybackInfoResponseSchema.parse(malformed)).toThrow();
  });

  // Regression: a strict enum here once had the power to stop playback
  // entirely. Zod fails an ARRAY when a single item fails, and `MediaStreams`
  // nests inside `MediaSources` inside this response - so one subtitle
  // carrying an unrecognized `DeliveryMethod` (newer server, fork,
  // undocumented value) failed the whole parse, `apiFetch` raised, and the
  // title would not open at all. A cosmetic field must never cost playback.
  it('keeps the response parseable when a subtitle has an unknown DeliveryMethod', () => {
    const fixture = {
      MediaSources: [
        {
          Id: 'src-1',
          Container: 'mkv',
          MediaStreams: [
            { Type: 'Subtitle', Index: 2, DeliveryMethod: 'SomeFutureMethod' },
            { Type: 'Subtitle', Index: 3, DeliveryMethod: 'Encode' },
          ],
        },
      ],
      PlaySessionId: 'session-1',
    };

    // The assertion that matters is simply that this does not throw: the
    // response stays usable and the title still plays. The unknown string is
    // carried through verbatim and dropped later, when
    // `subtitleDeliveryMethodsOf` narrows to the known values.
    const parsed = JellyfinPlaybackInfoResponseSchema.parse(fixture);
    const streams = parsed.MediaSources[0].MediaStreams ?? [];

    expect(streams).toHaveLength(2);
    expect(streams[1]?.DeliveryMethod).toBe('Encode');
  });
});
