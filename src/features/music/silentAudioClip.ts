// A few milliseconds of silence, built in memory and handed to an <audio>
// element as a `data:` URL.
//
// WHY IT IS BUILT HERE AND NOT FETCHED: the whole point is that it must be
// available when the network is not. The escape element (see
// `escapeFromAudioGraph` in MusicPlayerProvider.tsx) needs to have played once
// from a user gesture BEFORE it is ever asked to take over, and the moment it
// is asked to take over is precisely the moment iOS has frozen this tab's
// network. A clip that needs a request would be a clip that is missing exactly
// when it is needed.
//
// WHY IT IS SILENT AND SHORT: it exists only to satisfy iOS's per-element
// user-activation requirement. It must be inaudible (nobody asked for a click
// at the start of their song) and it must end on its own within a few
// milliseconds, so the element releases whatever hold it had before the real
// track is ready to sound.

// 8 kHz, 8-bit, mono. Small enough that the whole file is a few hundred bytes
// of base64 in the bundle, long enough that a browser treats it as a real,
// playable resource rather than a malformed stub.
const SAMPLE_RATE = 8_000;
const SAMPLE_COUNT = 400; // 50ms
// 8-bit PCM is UNSIGNED: silence is the midpoint 128, not 0. Filling with 0
// would emit a hard DC offset — a click, exactly what this must not do.
const SILENT_SAMPLE = 128;
const WAV_HEADER_BYTES = 44;

function buildSilentWavDataUri(): string {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + SAMPLE_COUNT);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + SAMPLE_COUNT, true); // chunk size: everything after this field
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format: uncompressed PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE, true); // byte rate = rate * channels * bytesPerSample
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, SAMPLE_COUNT, true);
  bytes.fill(SILENT_SAMPLE, WAV_HEADER_BYTES);

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let cached: string | null = null;

/**
 * The clip, built once per page load and reused. Lazy rather than a
 * module-level constant so importing this module costs nothing until the
 * first user gesture actually needs it, and so a `btoa`-less environment
 * (a test runner, a server render) only trips when something asks.
 *
 * Returns an empty string if the clip cannot be built. Callers must treat
 * that as "skip the unlock" — never as a source to assign.
 */
export function silentAudioClip(): string {
  if (cached !== null) return cached;
  try {
    cached = buildSilentWavDataUri();
  } catch {
    cached = '';
  }
  return cached;
}

// ── THE PLACEHOLDER TONE ─────────────────────────────────────────────────
//
// A SECOND clip, deliberately not the one above, because it answers a
// different question and the difference is what made the first attempt fail on
// the owner's phone.
//
// The clip above exists to satisfy iOS's per-element user-activation rule: it
// must be inaudible and it must END ON ITS OWN in a few milliseconds. Digital
// silence is exactly right for that.
//
// The placeholder tone has the opposite job: to hold a real now-playing
// session for as long as it takes the song to arrive, so the phone can be
// locked immediately after tapping play. On device that did not work — no
// lock-screen panel appeared at all — and two properties of the first clip
// explain why:
//
//   1. IT IS PURE DIGITAL SILENCE. Every sample is the 8-bit midpoint, so the
//      decoded signal is a flat line. WebKit does not owe a now-playing
//      session to a page that is technically "playing" nothing, and the
//      observed behaviour is that it does not grant one.
//   2. IT IS 50 MILLISECONDS. Even looping, a resource that short reads more
//      like a UI blip than like media playback.
//
// So this one carries an actual waveform at an amplitude nobody can hear — ±2
// counts of a 16-bit range, about -84 dBFS, which is far below the noise floor
// of any speaker or headphone — and runs for a full second before looping.
// Real signal, real duration, inaudible in practice.
const TONE_SAMPLE_RATE = 8_000;
const TONE_SAMPLE_COUNT = TONE_SAMPLE_RATE; // one second
// 16-bit PCM is SIGNED, so silence is 0 and this is a genuine oscillation
// around it. Two counts out of 32768 is inaudible; zero would be the flat line
// that gets ignored.
const TONE_AMPLITUDE = 2;
const TONE_BYTES_PER_SAMPLE = 2;

function buildToneWavDataUri(): string {
  const dataBytes = TONE_SAMPLE_COUNT * TONE_BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TONE_SAMPLE_RATE, true);
  view.setUint32(28, TONE_SAMPLE_RATE * TONE_BYTES_PER_SAMPLE, true);
  view.setUint16(32, TONE_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // A slow triangle rather than a square: a square wave at any amplitude has
  // instantaneous edges, and an edge is broadband — at the loop seam that is
  // the one thing that could actually become an audible tick.
  const period = 200; // 40 Hz at 8 kHz, well below anything a phone reproduces
  for (let i = 0; i < TONE_SAMPLE_COUNT; i += 1) {
    const phase = (i % period) / period;
    const triangle = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
    view.setInt16(
      WAV_HEADER_BYTES + i * TONE_BYTES_PER_SAMPLE,
      Math.round(triangle * TONE_AMPLITUDE),
      true,
    );
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let toneCached: string | null = null;

/**
 * One second of inaudible-but-real audio, for the placeholder element that
 * holds the now-playing session while a track loads. Built once per page load.
 *
 * Returns an empty string if it cannot be built; callers must treat that as
 * "no tone", never as a source to assign.
 */
export function placeholderToneClip(): string {
  if (toneCached !== null) return toneCached;
  try {
    toneCached = buildToneWavDataUri();
  } catch {
    toneCached = '';
  }
  return toneCached;
}
