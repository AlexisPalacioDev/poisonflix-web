import type { SeriesEpisode } from '../../hooks/useSeriesEpisodes';
import { languageDisplayName } from '../../lib/domain/languageNames';

// Per-series language coverage (owner ask #4, live Bleach repro: 95
// episodes, 71 with an embedded Spanish subtitle, 24 without). The panel
// used to source a series' language chips from a SINGLE episode's Jellyfin
// item - `audioLanguages.ts`'s `audioLanguagesOf`/`subtitleLanguagesOf` -
// and present that one file's languages as if they were the whole series'.
// A bare "Español" chip covering 75% of the episodes is a softer version of
// the exact lie the owner reported: the chip existing said "the series has
// Spanish"; its absence would have said the opposite; neither says "in 71 of
// 95". These two helpers aggregate over EVERY episode's own `mediaStreams`
// (already carried per-episode by `useSeriesEpisodes.ts` - the client-side
// aggregation the architecture decision requires) into real coverage counts,
// so the panel can render `Español · 71 de 95` instead.
//
// Deliberately duplicates `audioLanguages.ts`'s tiny raw-stream readers
// rather than importing them: those are `Pick<JellyfinItem, 'MediaStreams'>`
// single-item functions, not `SeriesEpisode[]`-shaped ones, and each reader
// is ~3 lines - same "intentionally duplicated, not worth a shared abstraction
// for ~5 lines" call `audioLanguages.ts` itself makes about
// `lib/domain/downloadProgress.ts`'s `percentOf`.

export interface LanguageCoverage {
  label: string;
  /** Episodes that have this language embedded, at least once. */
  count: number;
  /** Total episodes considered (the full series/season episode count, not just the ones with a file). */
  total: number;
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function languageLabelsInEpisode(streams: unknown[], streamType: 'Audio' | 'Subtitle'): Set<string> {
  const labels = new Set<string>();
  for (const raw of streams) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (readString(obj, 'Type') !== streamType) continue;

    const code = readString(obj, 'Language');
    if (!code) continue;

    labels.add(languageDisplayName(code, code.toUpperCase()));
  }
  return labels;
}

/**
 * Coverage for every distinct language of `streamType` found across
 * `episodes`, denominated against the FULL episode count (`episodes.length`)
 * - not just the episodes that happen to have a file yet. An episode with no
 * `mediaStreams` (not downloaded, or Sonarr-only) contributes to the total
 * but to no language's count - it neither confirms nor denies that language,
 * it simply isn't there to check. Sorted most-covered first, so the panel's
 * priority ordering (`prioritizeLanguages.ts`) sees the series' dominant
 * languages before its rarest ones.
 */
function languageCoverageOf(episodes: SeriesEpisode[], streamType: 'Audio' | 'Subtitle'): LanguageCoverage[] {
  const total = episodes.length;
  const counts = new Map<string, number>();

  for (const episode of episodes) {
    if (!episode.mediaStreams) continue;
    for (const label of languageLabelsInEpisode(episode.mediaStreams, streamType)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count, total }))
    .sort((a, b) => b.count - a.count);
}

/** Every distinct audio-track language embedded across the series' episodes, with real per-episode coverage. */
export function seriesAudioLanguagesOf(episodes: SeriesEpisode[]): LanguageCoverage[] {
  return languageCoverageOf(episodes, 'Audio');
}

/** Every distinct subtitle-track language embedded across the series' episodes, with real per-episode coverage. */
export function seriesSubtitleLanguagesOf(episodes: SeriesEpisode[]): LanguageCoverage[] {
  return languageCoverageOf(episodes, 'Subtitle');
}
