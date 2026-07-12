import { describe, expect, it } from 'vitest';
import type { JellyfinMediaSource, JellyfinPlaybackInfoResponse } from '../../api/schemas/jellyfin';
import {
  buildDirectPlayUrl,
  resolvePlayback,
  resolveStreamSource,
  resumePositionMs,
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
