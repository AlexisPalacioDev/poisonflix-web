import { describe, expect, it } from 'vitest';
import { jellyfinPosterUrl, tmdbPosterUrl } from './posterUrl';

describe('jellyfinPosterUrl', () => {
  it('returns null when the item has no Primary image tag', () => {
    expect(jellyfinPosterUrl({ Id: 'item-1', ImageTags: null }, 'token')).toBeNull();
    expect(jellyfinPosterUrl({ Id: 'item-1', ImageTags: {} }, 'token')).toBeNull();
  });

  it('builds an authenticated Items/{id}/Images/Primary URL with the tag and api_key', () => {
    const url = jellyfinPosterUrl(
      { Id: 'item-1', ImageTags: { Primary: 'tag-abc' } },
      'tok-123',
    );

    expect(url).not.toBeNull();
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/item-1/Images/Primary');
    expect(parsed.searchParams.get('tag')).toBe('tag-abc');
    expect(parsed.searchParams.get('api_key')).toBe('tok-123');
    expect(parsed.searchParams.get('maxWidth')).toBe('400');
  });

  it('omits api_key when no token is available', () => {
    const url = jellyfinPosterUrl({ Id: 'item-1', ImageTags: { Primary: 'tag-abc' } }, null);
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.searchParams.has('api_key')).toBe(false);
  });
});

describe('tmdbPosterUrl', () => {
  it('returns null when posterPath is absent', () => {
    expect(tmdbPosterUrl(null)).toBeNull();
    expect(tmdbPosterUrl(undefined)).toBeNull();
  });

  it('resolves a relative TMDB posterPath against the image CDN', () => {
    expect(tmdbPosterUrl('/abc123.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc123.jpg');
  });
});
