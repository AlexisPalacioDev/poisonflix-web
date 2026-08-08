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
});
