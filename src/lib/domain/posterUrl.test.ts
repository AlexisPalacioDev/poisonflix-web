import { describe, expect, it } from 'vitest';
import { jellyfinPosterUrl, resolveCoverUrl, tmdbPosterUrl } from './posterUrl';

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

describe('resolveCoverUrl (cover-art fallback chain)', () => {
  it('uses the item\'s own Primary image when present', () => {
    const url = resolveCoverUrl(
      {
        Id: 'song-1',
        ImageTags: { Primary: 'own-tag' },
        AlbumId: 'album-1',
        AlbumPrimaryImageTag: 'album-tag',
        ArtistItems: [{ Id: 'artist-1', Name: 'A' }],
      },
      'tok',
    );
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/song-1/Images/Primary');
    expect(parsed.searchParams.get('tag')).toBe('own-tag');
  });

  it('falls back to the album image when the item has no Primary but an AlbumId + tag', () => {
    const url = resolveCoverUrl(
      {
        Id: 'song-1',
        ImageTags: {},
        AlbumId: 'album-1',
        AlbumPrimaryImageTag: 'album-tag',
        ArtistItems: [{ Id: 'artist-1', Name: 'A' }],
      },
      'tok',
    );
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/album-1/Images/Primary');
    expect(parsed.searchParams.get('tag')).toBe('album-tag');
    expect(parsed.searchParams.get('api_key')).toBe('tok');
  });

  it('falls back to the first artist image when there is no item or album cover', () => {
    const url = resolveCoverUrl(
      {
        Id: 'song-1',
        ImageTags: null,
        AlbumId: 'album-1', // present but no AlbumPrimaryImageTag → album has no cover
        ArtistItems: [{ Id: 'artist-1', Name: 'A' }],
      },
      'tok',
    );
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/artist-1/Images/Primary');
    expect(parsed.searchParams.has('tag')).toBe(false);
    expect(parsed.searchParams.get('api_key')).toBe('tok');
  });

  it('falls back to AlbumArtists when ArtistItems is absent', () => {
    const url = resolveCoverUrl(
      {
        Id: 'song-1',
        ImageTags: {},
        AlbumArtists: [{ Id: 'album-artist-1', Name: 'A' }],
      },
      'tok',
    );
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/album-artist-1/Images/Primary');
  });

  it('returns null when the item has no image anywhere in the chain', () => {
    expect(
      resolveCoverUrl({ Id: 'song-1', ImageTags: {} }, 'tok'),
    ).toBeNull();
  });

  it('threads the maxWidth through so MediaSession can swap resolutions', () => {
    const url = resolveCoverUrl(
      { Id: 'song-1', ImageTags: {}, AlbumId: 'album-1', AlbumPrimaryImageTag: 'album-tag' },
      'tok',
      600,
    );
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.searchParams.get('maxWidth')).toBe('600');
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
