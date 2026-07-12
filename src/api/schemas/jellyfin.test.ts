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
});
