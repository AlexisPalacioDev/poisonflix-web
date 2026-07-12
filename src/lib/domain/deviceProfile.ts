// Jellyfin `DeviceProfile` sent with every `PlaybackInfo` request, ported
// from the native reference's `DeviceProfileFactory.kt`, adapted for a
// browser `<video>` target instead of Media3/ExoPlayer.
//
// ## Why this exists (root cause of the HEVC playback bug)
// Without a `DeviceProfile` in the `PlaybackInfo` request body, Jellyfin
// falls back to a permissive default and reports `SupportsDirectPlay: true`
// even for codecs no browser can decode (confirmed live: an empty/`null`
// profile against a real HEVC/EAC3/MKV title answered `SupportsDirectPlay:
// true`, no `TranscodingUrl` at all - the client had no way to know
// playback would fail until the `<video>` element silently errored).
// Declaring an explicit, narrow `DirectPlayProfiles` list is what makes
// Jellyfin correctly answer `SupportsDirectPlay: false` + a `TranscodingUrl`
// for anything outside it.
//
// ## Codec choices
// `DirectPlayProfiles` is deliberately narrow: H.264 video + AAC audio in an
// MP4 container - universally decodable by every evergreen browser with no
// plugin. Anything else (HEVC, VP9-in-MKV, EAC3/DTS audio, etc.) falls
// through to `TranscodingProfiles` and comes back with an HLS
// `TranscodingUrl` instead. Erring toward "ask the server to transcode" for
// borderline content is safe (slower, but correct); erring toward
// direct-play for something the browser can't actually decode is NOT
// (silent playback failure with no fallback, since the server would never
// offer a `TranscodingUrl` for something it believes is direct-playable).
//
// `TranscodingProfiles` requests HLS (`ts` segments, H.264/AAC) - the format
// `hls.js`/native Safari HLS can play (design.md §10's hls.js seam).

export interface JellyfinDirectPlayProfile {
  Type: 'Video' | 'Audio';
  Container: string;
  VideoCodec?: string;
  AudioCodec?: string;
}

export interface JellyfinTranscodingProfile {
  Type: 'Video' | 'Audio';
  Container: string;
  Protocol: string;
  VideoCodec?: string;
  AudioCodec?: string;
  Context: string;
}

export interface JellyfinDeviceProfile {
  MaxStreamingBitrate: number;
  DirectPlayProfiles: JellyfinDirectPlayProfile[];
  TranscodingProfiles: JellyfinTranscodingProfile[];
}

const MAX_STREAMING_BITRATE = 20_000_000;

/**
 * The single `DeviceProfile` this client declares on every `PlaybackInfo`
 * request. A pure function (no browser/DOM access) so it stays unit-testable
 * without jsdom quirks, mirroring `DeviceProfileFactory.create()`.
 */
export function createBrowserDeviceProfile(): JellyfinDeviceProfile {
  return {
    MaxStreamingBitrate: MAX_STREAMING_BITRATE,
    DirectPlayProfiles: [
      { Type: 'Video', Container: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac' },
      { Type: 'Audio', Container: 'mp3,aac,flac,m4a', AudioCodec: 'aac,mp3,flac' },
    ],
    TranscodingProfiles: [
      {
        Type: 'Video',
        Container: 'ts',
        Protocol: 'hls',
        VideoCodec: 'h264',
        AudioCodec: 'aac',
        Context: 'Streaming',
      },
    ],
  };
}
