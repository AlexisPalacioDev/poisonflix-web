import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { languageDisplayName } from '../../lib/domain/languageNames';

// Media-language readouts for Detail's poster panel (feature-map §7,
// walkthrough §15/§19). All three helpers below read the SAME raw Jellyfin
// `MediaStreams` array (left as `z.array(z.unknown())` by
// `api/schemas/jellyfin.ts` - out of this change's touchable-files list, same
// reason `features/player/mediaStreamTracks.ts` keeps its own defensive
// reader instead of widening the shared schema).
//
// Confirmed live against the actual server (Inception / Severance): Jellyfin
// DOES return a full `MediaStreams` array - both `Audio` and `Subtitle`
// entries, with `Language`/`IsDefault` populated - for any item fetched with
// `Fields=MediaStreams`. "Idiomas/subtítulos disponibles" not rendering was
// never a data problem: `subtitleLanguagesOf`/`defaultAudioLanguageOf` below
// simply didn't exist yet (only the audio line was ever built), and neither
// was ever wired up for a SERIES - a Jellyfin `Series` item carries no
// `MediaStreams` of its own (only its episodes do), so `DetailScreen` must
// resolve one playable episode's item to source this for a series.

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBoolean(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true;
}

function languagesOf(
  item: Pick<JellyfinItem, 'MediaStreams'> | null | undefined,
  streamType: 'Audio' | 'Subtitle',
): string[] {
  const streams = item?.MediaStreams;
  if (!streams) return [];

  const labels: string[] = [];
  const seen = new Set<string>();

  for (const raw of streams) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (readString(obj, 'Type') !== streamType) continue;

    const code = readString(obj, 'Language');
    if (!code) continue;

    const label = languageDisplayName(code, code.toUpperCase());
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  return labels;
}

/** Every distinct audio-track language embedded in the file, deduped and
 * translated - "und" (undetermined) reads as "UND" rather than vanishing. */
export function audioLanguagesOf(item: Pick<JellyfinItem, 'MediaStreams'> | null | undefined): string[] {
  return languagesOf(item, 'Audio');
}

/** Every distinct subtitle-track language embedded in the file, deduped and
 * translated - same rules as `audioLanguagesOf`, just `Type === "Subtitle"`. */
export function subtitleLanguagesOf(item: Pick<JellyfinItem, 'MediaStreams'> | null | undefined): string[] {
  return languagesOf(item, 'Subtitle');
}

/**
 * The language the file actually plays in by default - i.e. "en qué idioma
 * se descargó" (owner's ask #2). Reads the audio stream Jellyfin itself
 * flags `IsDefault: true` (the muxed default, set by whichever release was
 * grabbed); falls back to the first audio stream when none is marked default
 * (some releases carry only one track and never bother flagging it). `null`
 * when the item has no audio streams at all (not yet resolved / no library
 * item).
 */
export function defaultAudioLanguageOf(item: Pick<JellyfinItem, 'MediaStreams'> | null | undefined): string | null {
  const streams = item?.MediaStreams;
  if (!streams) return null;

  let fallback: string | null = null;

  for (const raw of streams) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (readString(obj, 'Type') !== 'Audio') continue;

    const code = readString(obj, 'Language');
    if (!code) continue;
    const label = languageDisplayName(code, code.toUpperCase());

    if (fallback == null) fallback = label;
    if (readBoolean(obj, 'IsDefault')) return label;
  }

  return fallback;
}
