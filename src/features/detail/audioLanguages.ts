import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { languageDisplayName } from '../../lib/domain/languageNames';

// "Audio disponible" line (feature-map §7, walkthrough §15/§19): reads a
// Jellyfin item's raw `MediaStreams` (left as `z.array(z.unknown())` by
// `api/schemas/jellyfin.ts` - out of this change's touchable-files list, same
// reason `features/player/mediaStreamTracks.ts` keeps its own defensive
// reader instead of widening the shared schema) and derives the deduped,
// human-readable audio language list shown under the meta line.
//
// Ported from `DetailMappers.kt`'s `audioLanguageDisplayName` + the
// `JellyfinItemDto.toMediaDetail` audioLanguages fold: filter `Type ===
// "Audio"`, drop streams with no language code at all (`mapNotNull`),
// translate known codes to their Spanish name, and fall back to the
// uppercased raw code for anything unrecognized - which is exactly why a
// Jellyfin stream tagged "und" (undetermined) reads as "Audio disponible:
// UND" in the walkthrough rather than being silently dropped.

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function audioLanguagesOf(item: Pick<JellyfinItem, 'MediaStreams'> | null | undefined): string[] {
  const streams = item?.MediaStreams;
  if (!streams) return [];

  const labels: string[] = [];
  const seen = new Set<string>();

  for (const raw of streams) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (readString(obj, 'Type') !== 'Audio') continue;

    const code = readString(obj, 'Language');
    if (!code) continue;

    const label = languageDisplayName(code, code.toUpperCase());
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  return labels;
}
