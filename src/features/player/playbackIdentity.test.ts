import { describe, expect, it } from 'vitest';
import type { PlaybackSource } from '../../lib/domain/streamResolver';
import { playbackIdentity } from './playbackIdentity';

function transcoded(hlsUrl: string): PlaybackSource {
  return { kind: 'Transcoded', hlsUrl };
}

describe('playbackIdentity', () => {
  it('ignores the PlaySessionId, which Jellyfin re-mints on every PlaybackInfo call', () => {
    const first = transcoded(
      '/jellyfin/videos/item-1/master.m3u8?MediaSourceId=ms-1&AudioStreamIndex=1&PlaySessionId=aaa',
    );
    const second = transcoded(
      '/jellyfin/videos/item-1/master.m3u8?MediaSourceId=ms-1&AudioStreamIndex=1&PlaySessionId=bbb',
    );

    expect(playbackIdentity(first)).toBe(playbackIdentity(second));
  });

  it.each([
    ['a different item', '/jellyfin/videos/item-2/master.m3u8?MediaSourceId=ms-1&AudioStreamIndex=1'],
    ['a different media source', '/jellyfin/videos/item-1/master.m3u8?MediaSourceId=ms-2&AudioStreamIndex=1'],
    ['a different audio track', '/jellyfin/videos/item-1/master.m3u8?MediaSourceId=ms-1&AudioStreamIndex=2'],
  ])('still separates %s', (_label, otherUrl) => {
    const base = transcoded('/jellyfin/videos/item-1/master.m3u8?MediaSourceId=ms-1&AudioStreamIndex=1');

    expect(playbackIdentity(base)).not.toBe(playbackIdentity(transcoded(otherUrl)));
  });

  // A rotated token really does invalidate the old URL, so unlike
  // PlaySessionId it must NOT be stripped - the stream has to be reopened.
  // Transcode urls spell it `ApiKey`, DirectPlay ones `api_key`; both stay.
  it.each([['ApiKey'], ['api_key']])('separates a rotated %s', (param) => {
    const before = transcoded(`/jellyfin/videos/item-1/master.m3u8?${param}=tok-1`);
    const after = transcoded(`/jellyfin/videos/item-1/master.m3u8?${param}=tok-2`);

    expect(playbackIdentity(before)).not.toBe(playbackIdentity(after));
  });

  // `joinUrl` (streamResolver.ts) passes an absolute TranscodingUrl through
  // untouched, so the host is part of what is being played. Dropping it would
  // make two different servers look like one stream.
  it('separates the same path served by different hosts', () => {
    const hostA = transcoded('https://host-a.example/videos/item-1/master.m3u8?MediaSourceId=ms-1');
    const hostB = transcoded('https://host-b.example/videos/item-1/master.m3u8?MediaSourceId=ms-1');
    const relative = transcoded('/videos/item-1/master.m3u8?MediaSourceId=ms-1');

    expect(playbackIdentity(hostA)).not.toBe(playbackIdentity(hostB));
    expect(playbackIdentity(hostA)).not.toBe(playbackIdentity(relative));
  });

  // Jellyfin builds its query deterministically today, but the identity must
  // not silently depend on that.
  it('does not depend on the order Jellyfin emits query params in', () => {
    const oneWay = transcoded('/jellyfin/videos/item-1/master.m3u8?AudioStreamIndex=2&MediaSourceId=ms-1');
    const theOther = transcoded('/jellyfin/videos/item-1/master.m3u8?MediaSourceId=ms-1&AudioStreamIndex=2');

    expect(playbackIdentity(oneWay)).toBe(playbackIdentity(theOther));
  });

  it('separates DirectPlay from Transcoded even at the same path', () => {
    const direct: PlaybackSource = { kind: 'DirectPlay', url: '/jellyfin/videos/item-1/stream.mkv' };
    const hls = transcoded('/jellyfin/videos/item-1/stream.mkv');

    expect(playbackIdentity(direct)).not.toBe(playbackIdentity(hls));
  });

  it('matches the parameter name case-insensitively', () => {
    const upper = transcoded('/jellyfin/videos/item-1/master.m3u8?PlaySessionId=aaa');
    const lower = transcoded('/jellyfin/videos/item-1/master.m3u8?playsessionid=bbb');

    expect(playbackIdentity(upper)).toBe(playbackIdentity(lower));
  });

  it('handles an absolute url and keeps every other parameter', () => {
    const identity = playbackIdentity(
      transcoded('https://media.example/jellyfin/videos/item-1/master.m3u8?PlaySessionId=aaa&SubtitleStreamIndex=3'),
    );

    expect(identity).toContain('SubtitleStreamIndex=3');
    expect(identity).not.toContain('aaa');
  });
});
