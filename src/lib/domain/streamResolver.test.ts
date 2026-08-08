import { describe, expect, it } from 'vitest';
import type { JellyfinMediaSource, JellyfinPlaybackInfoResponse } from '../../api/schemas/jellyfin';
import {
  buildAudioStreamUrl,
  buildDirectPlayUrl,
  resolvePlayback,
  resolveStreamSource,
  resumePositionMs,
  secondsToTicks,
  subtitleDeliveryMethodsOf,
  ticksToMs,
} from './streamResolver';

function mediaSource(overrides: Partial<JellyfinMediaSource> & { Id: string }): JellyfinMediaSource {
  return {
    Id: overrides.Id,
    Path: null,
    Container: null,
    RunTimeTicks: null,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    TranscodingUrl: null,
    TranscodingSubProtocol: null,
    MediaStreams: [],
    DefaultAudioStreamIndex: null,
    DefaultSubtitleStreamIndex: null,
    ...overrides,
  };
}

describe('ticksToMs', () => {
  it('converts Jellyfin ticks (100ns units) to whole milliseconds', () => {
    expect(ticksToMs(100_000_000)).toBe(10_000);
    expect(ticksToMs(30_000_000)).toBe(3_000);
    expect(ticksToMs(0)).toBe(0);
  });
});

describe('resumePositionMs', () => {
  it('converts a positive tick count to ms', () => {
    expect(resumePositionMs(100_000_000)).toBe(10_000);
  });

  it('returns 0 for zero, negative, null, or undefined ticks (no seek per player spec)', () => {
    expect(resumePositionMs(0)).toBe(0);
    expect(resumePositionMs(-5)).toBe(0);
    expect(resumePositionMs(null)).toBe(0);
    expect(resumePositionMs(undefined)).toBe(0);
  });
});

describe('secondsToTicks', () => {
  it('converts a positive seconds value to Jellyfin ticks (100ns units)', () => {
    expect(secondsToTicks(10)).toBe(100_000_000);
    expect(secondsToTicks(1.5)).toBe(15_000_000);
  });

  it('clamps zero/negative/non-finite input to 0', () => {
    expect(secondsToTicks(0)).toBe(0);
    expect(secondsToTicks(-5)).toBe(0);
    expect(secondsToTicks(Number.NaN)).toBe(0);
  });
});

describe('buildDirectPlayUrl', () => {
  it('builds the api_key-authenticated DirectPlay URL with static+mediaSourceId+api_key, in order', () => {
    const url = buildDirectPlayUrl(
      'item-1',
      { Id: 'ms-1', Container: 'mkv' },
      'TOKEN123',
      '/jellyfin',
    );

    expect(url).toBe('/jellyfin/Videos/item-1/stream.mkv?static=true&mediaSourceId=ms-1&api_key=TOKEN123');
  });

  it('omits the container extension when Container is absent', () => {
    const url = buildDirectPlayUrl('item-1', { Id: 'ms-1', Container: null }, 'TOKEN123', '/jellyfin');

    expect(url).toBe('/jellyfin/Videos/item-1/stream?static=true&mediaSourceId=ms-1&api_key=TOKEN123');
  });

  it('normalizes a base without a trailing slash', () => {
    const url = buildDirectPlayUrl('item-1', { Id: 'ms-1', Container: 'mp4' }, 'TOKEN', '/jellyfin/');

    expect(url).toBe('/jellyfin/Videos/item-1/stream.mp4?static=true&mediaSourceId=ms-1&api_key=TOKEN');
  });
});

describe('resolveStreamSource', () => {
  it('resolves DirectPlay when no TranscodingUrl is present', () => {
    const source = resolveStreamSource(
      'item-1',
      mediaSource({ Id: 'ms-1', Container: 'mp4', TranscodingUrl: null }),
      'TOKEN',
      '/jellyfin',
    );

    expect(source).toEqual({
      kind: 'DirectPlay',
      url: '/jellyfin/Videos/item-1/stream.mp4?static=true&mediaSourceId=ms-1&api_key=TOKEN',
    });
  });

  it('resolves Transcoded (not-supported marker) when TranscodingUrl is present', () => {
    const source = resolveStreamSource(
      'item-1',
      mediaSource({ Id: 'ms-1', TranscodingUrl: '/videos/item-1/master.m3u8' }),
      'TOKEN',
      '/jellyfin',
    );

    expect(source).toEqual({ kind: 'Transcoded', hlsUrl: '/jellyfin/videos/item-1/master.m3u8' });
  });

  it('passes an already-absolute TranscodingUrl through unchanged', () => {
    const source = resolveStreamSource(
      'item-1',
      mediaSource({ Id: 'ms-1', TranscodingUrl: 'http://jf.local:8096/videos/item-1/master.m3u8' }),
      'TOKEN',
      '/jellyfin',
    );

    expect(source).toEqual({ kind: 'Transcoded', hlsUrl: 'http://jf.local:8096/videos/item-1/master.m3u8' });
  });
});

describe('resolvePlayback', () => {
  it('resolves the first MediaSource and carries mediaSourceId + playSessionId', () => {
    const playbackInfo: JellyfinPlaybackInfoResponse = {
      MediaSources: [mediaSource({ Id: 'ms-1', Container: 'mp4', TranscodingUrl: null })],
      PlaySessionId: 'session-1',
    };

    const resolved = resolvePlayback('item-1', playbackInfo, 'TOKEN', '/jellyfin');

    expect(resolved).toEqual({
      source: {
        kind: 'DirectPlay',
        url: '/jellyfin/Videos/item-1/stream.mp4?static=true&mediaSourceId=ms-1&api_key=TOKEN',
      },
      mediaSourceId: 'ms-1',
      playSessionId: 'session-1',
      subtitleDeliveryMethods: {},
    });
  });

  it('defaults playSessionId to null when absent', () => {
    const playbackInfo: JellyfinPlaybackInfoResponse = {
      MediaSources: [mediaSource({ Id: 'ms-1' })],
      PlaySessionId: null,
    };

    const resolved = resolvePlayback('item-1', playbackInfo, 'TOKEN', '/jellyfin');

    expect(resolved.playSessionId).toBeNull();
  });

  it('throws when Jellyfin returns no MediaSources', () => {
    const playbackInfo: JellyfinPlaybackInfoResponse = { MediaSources: [], PlaySessionId: null };

    expect(() => resolvePlayback('item-1', playbackInfo, 'TOKEN', '/jellyfin')).toThrow(
      'Jellyfin returned no MediaSources for item item-1',
    );
  });
});

// Subtitle dedup bug fix (player spec): `DeliveryMethod` on a subtitle
// MediaStream means the server already decided how THIS session delivers it
// - `Encode` means burned into the video's pixels, which the client must
// never ALSO sideload (see `mediaStreamTracks.ts`'s `isBurnedInSubtitle`).
describe('subtitleDeliveryMethodsOf', () => {
  it('maps subtitle stream index -> DeliveryMethod, ignoring non-subtitle streams and streams without one', () => {
    const source = mediaSource({
      Id: 'ms-1',
      MediaStreams: [
        { Index: 0, Type: 'Video' },
        { Index: 1, Type: 'Audio', DeliveryMethod: undefined },
        { Index: 2, Type: 'Subtitle', Codec: 'ass', DeliveryMethod: 'Encode' },
        { Index: 3, Type: 'Subtitle', Codec: 'subrip' },
      ] as never,
    });

    expect(subtitleDeliveryMethodsOf(source)).toEqual({ 2: 'Encode' });
  });

  it('returns an empty map when MediaStreams is empty (DirectPlay - no transcode, nothing burned in)', () => {
    const source = mediaSource({ Id: 'ms-1', MediaStreams: [] });
    expect(subtitleDeliveryMethodsOf(source)).toEqual({});
  });

  // The wire field is a plain string so an unrecognized value can never fail
  // the whole PlaybackInfo parse and block playback. This is where it gets
  // filtered: an unknown method reads as "no delivery method", so the client
  // treats that subtitle exactly as it did before the field was modelled -
  // and, crucially, the recognized stream beside it survives.
  it('drops a DeliveryMethod outside the known set instead of trusting it', () => {
    const source = mediaSource({
      Id: 'ms-1',
      MediaStreams: [
        { Index: 2, Type: 'Subtitle', Codec: 'ass', DeliveryMethod: 'SomeFutureMethod' },
        { Index: 3, Type: 'Subtitle', Codec: 'subrip', DeliveryMethod: 'Encode' },
      ] as never,
    });

    expect(subtitleDeliveryMethodsOf(source)).toEqual({ 3: 'Encode' });
  });

  it('can carry more than one entry (e.g. an External subtitle alongside an Encode-delivered one)', () => {
    const source = mediaSource({
      Id: 'ms-1',
      MediaStreams: [
        { Index: 2, Type: 'Subtitle', DeliveryMethod: 'Encode' },
        { Index: 3, Type: 'Subtitle', DeliveryMethod: 'External' },
      ] as never,
    });

    expect(subtitleDeliveryMethodsOf(source)).toEqual({ 2: 'Encode', 3: 'External' });
  });
});

describe('resolvePlayback — subtitleDeliveryMethods pass-through (subtitle dedup bug fix)', () => {
  it('carries the resolved MediaSource\'s subtitle DeliveryMethod map', () => {
    const playbackInfo: JellyfinPlaybackInfoResponse = {
      MediaSources: [
        mediaSource({
          Id: 'ms-1',
          TranscodingUrl: '/videos/item-1/master.m3u8',
          MediaStreams: [{ Index: 2, Type: 'Subtitle', Codec: 'ass', DeliveryMethod: 'Encode' }] as never,
        }),
      ],
      PlaySessionId: 'session-1',
    };

    const resolved = resolvePlayback('item-1', playbackInfo, 'TOKEN', '/jellyfin');
    expect(resolved.subtitleDeliveryMethods).toEqual({ 2: 'Encode' });
  });
});

describe('buildAudioStreamUrl', () => {
  it('builds the static DirectPlay Audio/{id}/stream.m4a URL with the token as api_key', () => {
    const url = buildAudioStreamUrl('audio-1', 'user-1', 'TOKEN', '/jellyfin');
    const parsed = new URL(url, 'http://app');

    expect(parsed.pathname).toBe('/jellyfin/Audio/audio-1/stream.m4a');
    expect(parsed.searchParams.get('static')).toBe('true');
    expect(parsed.searchParams.get('api_key')).toBe('TOKEN');
  });

  it('normalizes a base without a trailing slash', () => {
    const url = buildAudioStreamUrl('audio-2', 'u', 't', '/jellyfin');
    expect(url.startsWith('/jellyfin/Audio/audio-2/stream.m4a?')).toBe(true);
  });
});
