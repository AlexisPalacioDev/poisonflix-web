import { describe, expect, it } from 'vitest';
import {
  audioItemToTrack,
  isRowActive,
  previewStreamUrl,
  searchResultToTrack,
  streamUrlSource,
} from './musicTrack';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicSearchResult } from '../../api/schemas/music';

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

// A minimal worker search hit; each test overrides only what it exercises.
function searchResult(overrides: Partial<MusicSearchResult> = {}): MusicSearchResult {
  return {
    videoId: 'vid-1',
    title: 'Song One',
    artist: 'The Band',
    artists: ['The Band'],
    album: null,
    durationSeconds: null,
    thumbnailUrl: 'https://i.ytimg.com/vi/vid-1/hq.jpg',
    source: 'ytmusic',
    genre: null,
    downloaded: false,
    jellyfinItemId: null,
    ...overrides,
  } as MusicSearchResult;
}

describe('previewStreamUrl', () => {
  it('proxies the videoId through the BFF stream route', () => {
    const parsed = new URL(previewStreamUrl('vid-1', 'ytmusic'), 'http://localhost');
    expect(parsed.pathname).toBe('/bff/music/stream');
    expect(parsed.searchParams.get('videoId')).toBe('vid-1');
    expect(parsed.searchParams.get('source')).toBe('ytmusic');
  });

  it('omits an unknown source so the worker picks one itself', () => {
    const parsed = new URL(previewStreamUrl('vid-1', null), 'http://localhost');
    expect(parsed.searchParams.has('source')).toBe(false);
  });
});

describe('streamUrlSource', () => {
  it('reads the source param back off a URL previewStreamUrl built', () => {
    expect(streamUrlSource(previewStreamUrl('vid-1', 'ytmusic'))).toBe('ytmusic');
    expect(streamUrlSource(previewStreamUrl('vid-1', 'youtube'))).toBe('youtube');
  });

  it('falls back to auto when the source param is absent', () => {
    expect(streamUrlSource('/bff/music/stream?videoId=vid-1')).toBe('auto');
  });

  it('falls back to auto for null/undefined', () => {
    expect(streamUrlSource(null)).toBe('auto');
    expect(streamUrlSource(undefined)).toBe('auto');
  });

  it('falls back to auto for an unrecognized source value', () => {
    expect(streamUrlSource('/bff/music/stream?videoId=vid-1&source=bogus')).toBe('auto');
  });

  it('never throws on a malformed or empty URL', () => {
    expect(() => streamUrlSource('::not a url::')).not.toThrow();
    expect(streamUrlSource('::not a url::')).toBe('auto');
    expect(streamUrlSource('')).toBe('auto');
  });
});

describe('searchResultToTrack', () => {
  // The radio mixes downloaded and not-yet-downloaded hits in one queue, so the
  // two branches below have to produce interchangeable player tracks.
  it('plays a downloaded hit from its Jellyfin item, with no preview src', () => {
    const track = searchResultToTrack(
      searchResult({ downloaded: true, jellyfinItemId: 'aud-9' }),
    );
    expect(track.itemId).toBe('aud-9');
    expect(track.streamUrl).toBeUndefined();
    expect(track.title).toBe('Song One');
    expect(track.artist).toBe('The Band');
  });

  it('streams a not-downloaded hit through the proxy, keyed by videoId', () => {
    const track = searchResultToTrack(searchResult());
    expect(track.itemId).toBe('vid-1');
    expect(new URL(track.streamUrl as string, 'http://localhost').pathname).toBe(
      '/bff/music/stream',
    );
  });

  it('falls back to the preview when the worker flags downloaded without an item id', () => {
    const track = searchResultToTrack(searchResult({ downloaded: true, jellyfinItemId: null }));
    expect(track.itemId).toBe('vid-1');
    expect(track.streamUrl).toBeDefined();
  });

  it('titles an untitled hit rather than rendering an empty row', () => {
    expect(searchResultToTrack(searchResult({ title: null })).title).toBe('Sin título');
  });
});

describe('isRowActive', () => {
  it('is false when nothing is playing', () => {
    expect(isRowActive(null, { videoId: 'vid-1' })).toBe(false);
  });

  it('matches a preview, whose videoId is also its itemId', () => {
    expect(isRowActive({ itemId: 'vid-1', videoId: 'vid-1' }, { videoId: 'vid-1' })).toBe(true);
  });

  it('matches the same song playing from the library after a download', () => {
    expect(
      isRowActive({ itemId: 'aud-9' }, { videoId: 'vid-1', playItemId: 'aud-9' }),
    ).toBe(true);
  });

  it('matches by videoId even when the row is not downloaded yet', () => {
    expect(isRowActive({ itemId: 'aud-9', videoId: 'vid-1' }, { videoId: 'vid-1' })).toBe(true);
  });

  it('does not light up a different song', () => {
    expect(
      isRowActive({ itemId: 'aud-9', videoId: 'vid-2' }, { videoId: 'vid-1', playItemId: 'aud-1' }),
    ).toBe(false);
  });

  it('does not match on a null playItemId colliding with nothing', () => {
    expect(isRowActive({ itemId: 'aud-9' }, { videoId: 'vid-1', playItemId: null })).toBe(false);
  });
});
