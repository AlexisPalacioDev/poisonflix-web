import { describe, expect, it } from 'vitest';
import { createBrowserDeviceProfile } from './deviceProfile';

// This is the root-cause fix's core contract: a narrow, explicit
// DirectPlayProfiles list is what makes Jellyfin actually enforce codec
// support (HEVC/EAC3/MKV -> a real TranscodingUrl) instead of assuming
// DirectPlay is always safe when the profile is null/empty.

describe('createBrowserDeviceProfile', () => {
  it('declares an H.264/AAC-only Video DirectPlay profile restricted to mp4', () => {
    const profile = createBrowserDeviceProfile();
    const videoProfile = profile.DirectPlayProfiles.find((p) => p.Type === 'Video');

    expect(videoProfile).toBeDefined();
    expect(videoProfile?.Container).toBe('mp4');
    expect(videoProfile?.VideoCodec).toBe('h264');
    expect(videoProfile?.AudioCodec).toBe('aac');
  });

  it('does NOT whitelist HEVC/H.265 or EAC3/AC3/DTS in any DirectPlay profile', () => {
    const profile = createBrowserDeviceProfile();
    const codecs = profile.DirectPlayProfiles.flatMap((p) => [p.VideoCodec, p.AudioCodec]).join(',').toLowerCase();

    expect(codecs).not.toContain('hevc');
    expect(codecs).not.toContain('h265');
    expect(codecs).not.toContain('eac3');
    expect(codecs).not.toContain('ac3');
    expect(codecs).not.toContain('dts');
  });

  it('declares an HLS TranscodingProfile (h264/aac, ts container) as the fallback for anything outside DirectPlay', () => {
    const profile = createBrowserDeviceProfile();
    const transcodingProfile = profile.TranscodingProfiles.find((p) => p.Type === 'Video');

    expect(transcodingProfile).toBeDefined();
    expect(transcodingProfile?.Protocol).toBe('hls');
    expect(transcodingProfile?.Container).toBe('ts');
    expect(transcodingProfile?.VideoCodec).toBe('h264');
    expect(transcodingProfile?.AudioCodec).toBe('aac');
  });

  // Regression: movies played far quieter than music because the browser, not
  // ffmpeg, was downmixing 5.1/7.1 to stereo - and a browser downmix drops the
  // center channel (dialogue) with no server setting able to compensate.
  it('caps transcoded audio at 2 channels so the server downmixes instead of the browser', () => {
    const profile = createBrowserDeviceProfile();
    const transcodingProfile = profile.TranscodingProfiles.find((p) => p.Type === 'Video');

    expect(transcodingProfile?.MaxAudioChannels).toBe('2');
  });

  // The type matters as much as the value, and only the SERIALIZED form proves
  // it: Jellyfin declares `public string? MaxAudioChannels`, so a numeric 2
  // deserializes to null server-side and the cap is dropped in silence - a
  // failure mode indistinguishable from never having set it. Asserting on the
  // JSON is what pins down the bytes that actually reach the server, rather
  // than re-reading the object literal we just wrote.
  it('serializes MaxAudioChannels as a quoted string in the request body', () => {
    const body = JSON.stringify(createBrowserDeviceProfile());

    expect(body).toContain('"MaxAudioChannels":"2"');
    expect(body).not.toContain('"MaxAudioChannels":2');
  });

  it('declares a sane MaxStreamingBitrate (not 0/undefined, which would starve playback)', () => {
    const profile = createBrowserDeviceProfile();
    expect(profile.MaxStreamingBitrate).toBeGreaterThan(0);
  });

  // Root cause of "elijo un audio, salgo y vuelvo, y vuelve a salir el audio
  // por defecto en inglés" for DirectPlay-eligible sources, verified against
  // jellyfin/jellyfin v10.11.11's `StreamBuilder.cs` + `ConditionProcessor.cs`
  // (`GetCompatibilityAudioCodecDirect` -> `GetProfileConditionsForVideoAudio`
  // only ever evaluates THIS profile's own `CodecProfiles`): Chrome does not
  // expose `HTMLMediaElement.audioTracks` (confirmed against a real Chromium
  // build - `'audioTracks' in document.createElement('video')` is `false`),
  // so an in-band audio switch is impossible, and `buildDirectPlayUrl`
  // (streamResolver.ts) always requests `static=true`, which Jellyfin's
  // `VideosController` serves byte-for-byte and never reads
  // `audioStreamIndex` from. The ONLY way to make a secondary audio track
  // audible is to make the SERVER refuse DirectPlay for it, so it falls back
  // to a stream Jellyfin actually builds around the requested
  // `AudioStreamIndex`. Without `CodecProfiles` declaring `IsSecondaryAudio`
  // unsupported (this test's subject), nothing disqualifies it and the
  // server happily reports `SupportsDirectPlay: true` for ANY requested
  // audio track and never emits a `TranscodingUrl` at all - exactly the
  // reported bug. This test only pins the shape THIS client sends (verified
  // live to be honored by a real server); it does NOT prove the full
  // request->response round trip, which needs `getPlaybackInfo` to ALSO send
  // a matching `MediaSourceId` (see `api/jellyfin.ts`'s
  // `GetPlaybackInfoBody.mediaSourceId` and its `PlayerScreen.test.tsx`
  // coverage) - a real server silently drops `AudioStreamIndex` without one,
  // independent of anything in this file.
  it('flags a secondary (non-first) audio track as unsupported for DirectPlay', () => {
    const profile = createBrowserDeviceProfile();
    const videoAudioProfile = profile.CodecProfiles?.find((p) => p.Type === 'VideoAudio');

    expect(videoAudioProfile).toBeDefined();
    const condition = videoAudioProfile?.Conditions.find((c) => c.Property === 'IsSecondaryAudio');
    expect(condition).toBeDefined();
    expect(condition?.Condition).toBe('Equals');
    expect(condition?.Value).toBe('false');
    // `IsRequired` defaults to `true` server-side when omitted
    // (`ProfileCondition`'s parameterless constructor, same tag) - which
    // would wrongly fail this condition whenever Jellyfin can't determine
    // `IsSecondaryAudio` for a stream, forcing an unnecessary transcode.
    // Must be sent explicitly as `false`, not merely left `undefined`.
    expect(condition?.IsRequired).toBe(false);
  });

  // Same precedent this file already set for `MaxAudioChannels` above: only
  // the SERIALIZED body proves what actually reaches the server. Pins the
  // exact wire shape (PascalCase keys, `IsRequired` present) so a refactor
  // can't silently rename a field the server matches case-sensitively-enough
  // to 400 on (live-confirmed: a bad `Property` value 400s the WHOLE
  // `PlaybackInfo` request, not just this condition).
  it('serializes the IsSecondaryAudio condition with the exact keys Jellyfin expects', () => {
    const body = JSON.parse(JSON.stringify(createBrowserDeviceProfile()));
    const videoAudioProfile = body.CodecProfiles.find((p: { Type: string }) => p.Type === 'VideoAudio');

    expect(videoAudioProfile.Conditions).toEqual([
      { Condition: 'Equals', Property: 'IsSecondaryAudio', Value: 'false', IsRequired: false },
    ]);
  });
});
