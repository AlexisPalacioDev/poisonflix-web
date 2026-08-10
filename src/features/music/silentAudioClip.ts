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
