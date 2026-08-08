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
//
// ## Why the transcoding profile caps audio at 2 channels
// Symptom: every movie played far quieter than the music library, to the point
// where dialogue was hard to make out. Music was unaffected - and that is the
// tell, because music never passes through here (it builds a static
// `Audio/{id}/stream.m4a` URL directly, no `PlaybackInfo`, no transcode).
//
// The library is mostly REMUX with 5.1/7.1 tracks. Without `MaxAudioChannels`,
// Jellyfin transcodes to AAC while KEEPING the source channel count, so the
// browser receives multichannel audio and performs the stereo downmix itself.
//
// Capping at 2 moves that downmix back to ffmpeg. This is the load-bearing
// part, verified against the server's own source at the tag running in
// production (v10.11.11): `EncodingHelper.GetAudioFilterParam` adds the
// `volume=<DownMixAudioBoost>` filter ONLY under
//
//     channels is 2 && state.AudioStream?.Channels is > 2
//
// (EncodingHelper.cs:2824-2835). Without a client-side cap that condition is
// never true, so the server's configured boost - 2.0, i.e. +100% - never ran
// a single time. The cap is what makes an already-configured setting apply.
//
// Note `DownMixStereoAlgorithm: None` does NOT disable the boost. It only
// skips the custom `pan` filter and uses ffmpeg's native downmix; the boost is
// an independent `if` (DownMixAlgorithmsHelper.cs). Worth being precise about
// what that buys: a flat `volume=2` gain over the whole mix, NOT a
// dialogue-aware remix. If dialogue specifically still gets buried under
// effects, the fix for that is the server's `NightmodeDialogue` algorithm
// (which weights the center channel: c2+0.30*c0+0.30*c4), not this file.
//
// The value is a STRING, not a number: Jellyfin declares this as
// `public string? MaxAudioChannels` (MediaBrowser.Model/Dlna/TranscodingProfile.cs:124).
// A numeric `2` deserializes to null and is silently ignored.
//
// Two costs, both accepted deliberately:
//
//  1. It gives up 5.1 passthrough on devices that could render it (e.g. a
//     soundbar on the webOS TV), in exchange for audible dialogue everywhere.
//  2. It costs server CPU beyond the video transcode. `CanStreamCopyAudio`
//     (EncodingHelper.cs:2543) refuses an audio stream-copy once
//     `audioStream.Channels > requestedChannels`, so a title that previously
//     transcoded video while copying its audio through untouched now
//     re-encodes the audio too. Production runs vaapi, so the video transcode
//     dominates and this should stay in the noise - but it is a real cost, not
//     a free win, and it is the first thing to look at if transcode start-up
//     latency regresses.

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
  /** Jellyfin's own type for this field is `string?`, not a number. */
  MaxAudioChannels?: string;
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
        MaxAudioChannels: '2',
      },
    ],
  };
}
