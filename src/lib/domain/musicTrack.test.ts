import { describe, expect, it } from 'vitest';
import { audioItemToTrack } from './musicTrack';
import type { JellyfinItem } from '../../api/schemas/jellyfin';

// A minimal `Audio` item; each test overrides only the fields it exercises.
function audioItem(overrides: Partial<JellyfinItem>): JellyfinItem {
  return {
    Id: 'song-1',
    Name: 'Song One',
    ...overrides,
  } as JellyfinItem;
}

describe('audioItemToTrack', () => {
  it('maps the core track fields (id, title, artist, artistId)', () => {
    const track = audioItemToTrack(
      audioItem({
        Artists: ['The Band'],
        ArtistItems: [{ Id: 'artist-1', Name: 'The Band' }],
      }),
      'tok',
    );
    expect(track.itemId).toBe('song-1');
    expect(track.title).toBe('Song One');
    expect(track.artist).toBe('The Band');
    expect(track.artistId).toBe('artist-1');
  });

  it('uses the item\'s own cover when it has a Primary image', () => {
    const track = audioItemToTrack(
      audioItem({
        ImageTags: { Primary: 'own-tag' },
        AlbumId: 'album-1',
        AlbumPrimaryImageTag: 'album-tag',
      }),
      'tok',
    );
    const parsed = new URL(track.coverUrl as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/song-1/Images/Primary');
    expect(parsed.searchParams.get('tag')).toBe('own-tag');
  });

  it('falls back to the album cover when the song has no image of its own', () => {
    const track = audioItemToTrack(
      audioItem({
        ImageTags: {},
        AlbumId: 'album-1',
        AlbumPrimaryImageTag: 'album-tag',
      }),
      'tok',
    );
    const parsed = new URL(track.coverUrl as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/album-1/Images/Primary');
    expect(parsed.searchParams.get('tag')).toBe('album-tag');
  });

  it('falls back to the artist image when neither song nor album has a cover', () => {
    const track = audioItemToTrack(
      audioItem({
        ImageTags: null,
        ArtistItems: [{ Id: 'artist-1', Name: 'The Band' }],
      }),
      'tok',
    );
    const parsed = new URL(track.coverUrl as string, 'http://localhost');
    expect(parsed.pathname).toBe('/jellyfin/Items/artist-1/Images/Primary');
  });

  it('yields a null cover (→ ♪ placeholder) when no image exists anywhere', () => {
    const track = audioItemToTrack(audioItem({ ImageTags: {} }), 'tok');
    expect(track.coverUrl).toBeNull();
  });
});
