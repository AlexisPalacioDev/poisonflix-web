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

/** Mirrors `MediaBrowser.Model.Dlna.ProfileConditionType` (verified against
 * jellyfin/jellyfin v10.11.11's `ProfileConditionType.cs`) - a typo here
 * fails silently in a plain `string` field (the server 400s the WHOLE
 * `PlaybackInfo` request, live-confirmed), so it's a literal union instead. */
export type JellyfinProfileConditionType = 'Equals' | 'NotEquals' | 'LessThanEqual' | 'GreaterThanEqual' | 'EqualsAny';

/** The subset of `MediaBrowser.Model.Dlna.ProfileConditionValue` (same tag)
 * this client actually has a reason to send - narrowed on purpose rather
 * than transcribing the full enum, since every unused member would be an
 * untested claim about server behavior. Extend it deliberately, not by
 * guessing a name. */
export type JellyfinProfileConditionProperty = 'IsSecondaryAudio';

export interface JellyfinCodecProfileCondition {
  Condition: JellyfinProfileConditionType;
  Property: JellyfinProfileConditionProperty;
  Value: string;
  /** Only matters when the checked value is unknown/missing server-side
   * (`ConditionProcessor.IsConditionSatisfied`'s bool overload) - `false`
   * matches jellyfin-web's own equivalent condition, since a genuinely
   * unknown "is this secondary audio?" should not, by itself, force a
   * transcode. */
  IsRequired?: boolean;
}

export interface JellyfinCodecProfile {
  Type: 'VideoAudio' | 'Audio' | 'Video';
  Conditions: JellyfinCodecProfileCondition[];
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

/** How the server should hand a subtitle format to this client.
 * `External` = a separate text file the client fetches and renders itself. */
export interface JellyfinSubtitleProfile {
  Format: string;
  Method: 'External' | 'Embed' | 'Hls' | 'Encode';
}

export interface JellyfinDeviceProfile {
  MaxStreamingBitrate: number;
  DirectPlayProfiles: JellyfinDirectPlayProfile[];
  TranscodingProfiles: JellyfinTranscodingProfile[];
  CodecProfiles?: JellyfinCodecProfile[];
  SubtitleProfiles?: JellyfinSubtitleProfile[];
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
    // ## Why SubtitleProfiles exists (three problems, one declaration)
    //
    // Without this list, Jellyfin assumes the client cannot consume subtitle
    // text and BURNS every subtitle into the transcoded video's pixels.
    // Measured against a real server on a title whose Spanish and English
    // subtitles are both plain external `.srt` files sitting next to the
    // video:
    //
    //     no SubtitleProfiles -> eng=Encode,   spa=Encode
    //     with this list      -> eng=External, spa=External
    //
    // That single flip fixes three separate things:
    //
    //  1. Dual subtitles become possible at all. Two burned-in tracks cannot
    //     be shown together - they are pixels, not text - so the owner's
    //     "inglés y español a la vez" request was unreachable while every
    //     subtitle came back as `Encode`.
    //  2. It removes the CAUSE of the duplicate-subtitle bug rather than
    //     coping with it. `isBurnedInSubtitle` (mediaStreamTracks.ts) still
    //     earns its place - image-based formats below are still burned, and
    //     older sessions can still report `Encode` - but text subtitles no
    //     longer take that path.
    //  3. It takes real load off the server. Burning subtitles forces a full
    //     video re-encode, since the picture itself has to change; delivering
    //     text lets the transcode stream-copy the video instead.
    //
    // The list is text formats ONLY, and that boundary is deliberate. Asking
    // for `External` delivery of an image-based subtitle (PGS, DVDSUB) would
    // hand the browser a bitmap stream it cannot draw; those are genuinely
    // un-renderable as text and SHOULD keep being burned in. The client always
    // fetches `Stream.vtt`, and Jellyfin converts any text format to WebVTT on
    // the way out, so listing srt/ass/ssa here costs nothing extra.
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'sub', Method: 'External' },
      { Format: 'microdvd', Method: 'External' },
    ],
    // ## Why CodecProfiles exists (audio-switch bug for DirectPlay sources)
    //
    // Symptom (owner report): pick a non-default audio track, leave the
    // player, come back - it's playing the file's default audio again.
    // Root cause #1, verified against jellyfin/jellyfin v10.11.11's
    // `StreamBuilder.cs`/`ConditionProcessor.cs` (`GetVideoDirectPlayProfile`
    // -> `GetCompatibilityAudioCodecDirect` -> `GetProfileConditionsForVideoAudio`):
    // that evaluator only ever looks at THIS profile's own `CodecProfiles`.
    // Without one, nothing disqualifies a requested audio track from
    // DirectPlay, so Jellyfin answers `SupportsDirectPlay: true` with no
    // `TranscodingUrl` regardless of which `AudioStreamIndex` was requested -
    // and `buildDirectPlayUrl` (streamResolver.ts) always asks for the
    // `static=true` byte-for-byte stream, which Jellyfin serves untouched and
    // never reads `audioStreamIndex` from at all (confirmed against
    // `VideosController`). Combined: a non-default pick on a
    // DirectPlay-eligible file was structurally unable to ever become
    // audible, on the initial restore (`resolveInitialAudio`) AND on a manual
    // `TrackMenu` pick alike.
    //
    // (Root cause #2, found while live-testing this fix against a real
    // server - equally required, just not this file's job: the server
    // discards `AudioStreamIndex`/`SubtitleStreamIndex` entirely unless the
    // request ALSO carries a matching `MediaSourceId`. See
    // `GetPlaybackInfoBody.mediaSourceId`'s doc comment in `api/jellyfin.ts`.)
    //
    // The fix leans on a mechanism this app already has wired end-to-end:
    // `handleAudioSwitchUnavailable` (PlayerScreen.tsx) already re-resolves
    // `PlaybackInfo` with the picked `AudioStreamIndex` whenever the
    // browser's own in-band switch isn't available - true for every Chromium
    // build today, since Chrome does not expose
    // `HTMLMediaElement.audioTracks` at all (confirmed against a real build:
    // `'audioTracks' in document.createElement('video')` is `false`). This
    // `CodecProfiles` entry is what makes that re-resolve actually matter:
    // declaring `IsSecondaryAudio` unsupported tells Jellyfin's
    // `StreamBuilder` that such a track disqualifies pure DirectPlay for THIS
    // profile, so it falls through to the transcode path and returns a real
    // `TranscodingUrl` built around the requested track - which
    // `resolveStreamSource` (streamResolver.ts) already knows how to pick up
    // as a `Transcoded` source, no other file needs to change.
    //
    // IMPORTANT precision (`MediaSourceInfo.IsSecondaryAudio`, same tag):
    // "secondary" here means "not the FIRST non-external audio `MediaStream`
    // by index", NOT "not the `IsDefault`-flagged one" - they usually
    // coincide but are not the same field. A file whose default audio isn't
    // its first audio stream would (correctly, per this same rule) also lose
    // DirectPlay when the player opens on that default - a real, accepted
    // trade-off for correctness on the common case, not a gap unique to this
    // client (jellyfin-web's own device profile ships the identical
    // condition below).
    //
    // Cost check (why this isn't "fix the audio, waste the CPU"): server-side
    // `EncodingHelper.CanStreamCopyVideo` (verified in the same tag) decides
    // video stream-copy purely from video-stream compatibility - it never
    // looks at WHY the session stopped being DirectPlay. Since the video
    // codec is already h264 (the only thing narrow enough to reach
    // DirectPlay under `DirectPlayProfiles` above), the resulting transcode
    // still stream-copies video (`-c:v copy`) and only re-encodes audio
    // (capped at 2ch by `TranscodingProfiles` below) - not a full video
    // re-encode. (This app's own library had no title that is BOTH
    // DirectPlay-eligible under the profile above AND carries more than one
    // compatible audio track, so this specific transition - DirectPlay ->
    // audio-only transcode - could not be demonstrated live end-to-end; it
    // follows from the verified source above, not from an observed
    // production case. What WAS demonstrated live: `CodecProfiles`
    // conditions are honored by a real server, and this exact condition
    // does not regress DirectPlay for any single-audio-track file.)
    //
    // `IsRequired: false` and the bare (codec/container-unrestricted)
    // `VideoAudio` profile use the SAME shape as jellyfin-web's own device
    // profile builder (`browserDeviceProfile.js`'s `!supportsSecondaryAudio`
    // branch) - not a bespoke invention. Unlike jellyfin-web, this condition
    // is sent UNCONDITIONALLY rather than gated behind a
    // `canPlaySecondaryAudio()`-style DOM probe: `createBrowserDeviceProfile`
    // is deliberately DOM-free (see this function's own doc comment) so it
    // stays trivially unit-testable, and every browser this app currently
    // targets fails that probe anyway (Chrome: no `audioTracks` at all;
    // Firefox: `audioTracks` exists but only ever sees one track). The
    // accepted cost is Safari (partial `audioTracks` support): it may take an
    // unnecessary but harmless audio-only transcode instead of a working
    // in-band switch. If genuine Safari-class support becomes worth
    // detecting, thread a `supportsInBandAudioSwitch` boolean into this
    // function from a call site that CAN touch the DOM, rather than adding
    // DOM access here.
    CodecProfiles: [
      {
        Type: 'VideoAudio',
        Conditions: [{ Condition: 'Equals', Property: 'IsSecondaryAudio', Value: 'false', IsRequired: false }],
      },
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
