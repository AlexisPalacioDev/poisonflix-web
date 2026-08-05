import { useMemo, useState } from 'react';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { SeriesEpisode } from '../../hooks/useSeriesEpisodes';
import { audioLanguagesOf, defaultAudioLanguageOf, subtitleLanguagesOf } from './audioLanguages';
import { prioritizeLanguages } from './prioritizeLanguages';
import { seriesAudioLanguagesOf, seriesSubtitleLanguagesOf, type LanguageCoverage } from './seriesLanguages';

// Detail-request spec's "Subtitle chip collapse for long lists": at most 4
// always-visible chips (app language, Español, Inglés, file default -
// deduplicated), the rest behind an expandable "+N" control. Applied to
// both language rows (audio lists are typically short, so this is a no-op
// there in practice, but keeps one code path instead of two).
const VISIBLE_CHIP_LIMIT = 4;

// Poster-side language card (owner asks #2 + #4): what the file actually
// downloaded/plays in by default, plus the full audio/subtitle breakdown
// embedded in it. One compact card next to the cover instead of the old
// scattered "Audio disponible" text line + the (now admin-only) torrents
// block - see src/styles/primitives.css's `.pf-glass`/`.pf-glass--blur` for
// the shared card treatment.
//
// `item` is the raw Jellyfin item (movie's own, or - for a series - the
// first playable episode's, since a Series item carries no MediaStreams of
// its own) - it always drives the "Descargado en X" line. `null`/`undefined`
// (not in the library yet, or a series with no playable episode) renders
// nothing, same as the line it replaces.
//
// `episodes` (series only, owner ask #4 / live Bleach repro: 95 episodes, 71
// with an embedded Spanish subtitle) switches the Audio/Subtítulos chip rows
// from "`item`'s one file" to real per-series coverage
// (`seriesLanguages.ts`): a chip that doesn't cover every episode reads
// `Label · count de total` instead of a bare label that silently implied
// 100% - the owner read a plain "Español" chip sourced from one lucky
// episode and concluded the series had NO Spanish. Movies never pass this
// prop and keep the original single-item chips unchanged.

interface MediaLanguagesPanelProps {
  item: JellyfinItem | null | undefined;
  isLoading: boolean;
  episodes?: SeriesEpisode[];
}

interface LanguageChipRowProps {
  label: string;
  coverage: LanguageCoverage[];
  defaultLanguage: string | null;
}

/** `Label` when every considered episode/file has it, `Label · count de total` otherwise - never silently implies full coverage. */
function chipText({ label, count, total }: LanguageCoverage): string {
  return count < total ? `${label} · ${count} de ${total}` : label;
}

function LanguageChipRow({ label, coverage, defaultLanguage }: LanguageChipRowProps) {
  const [expanded, setExpanded] = useState(false);
  const labels = useMemo(() => coverage.map((entry) => entry.label), [coverage]);
  const byLabel = useMemo(() => new Map(coverage.map((entry) => [entry.label, entry])), [coverage]);
  const { shown, hidden } = useMemo(
    () => prioritizeLanguages(labels, defaultLanguage, VISIBLE_CHIP_LIMIT),
    [labels, defaultLanguage],
  );
  const visible = expanded ? labels : shown;

  return (
    <div className="pf-media-langs__row">
      <span className="pf-media-langs__label">{label}</span>
      <ul className="pf-media-langs__chips">
        {visible.map((lang, index) => (
          <li key={`${lang}-${index}`} className="pf-media-langs__chip">
            {chipText(byLabel.get(lang) as LanguageCoverage)}
          </li>
        ))}
      </ul>
      {!expanded && hidden.length > 0 && (
        <button type="button" className="pf-media-langs__more" onClick={() => setExpanded(true)}>
          +{hidden.length}
        </button>
      )}
    </div>
  );
}

/** Wraps a single-item's language list as "full coverage" (count === total === 1 per language) - the movie/single-file shape `chipText` renders as a plain label, same as before this rework. */
function fullCoverageOf(languages: string[]): LanguageCoverage[] {
  return languages.map((label) => ({ label, count: 1, total: 1 }));
}

export function MediaLanguagesPanel({ item, episodes, isLoading }: MediaLanguagesPanelProps) {
  const downloadLanguage = useMemo(() => defaultAudioLanguageOf(item), [item]);

  const audioCoverage = useMemo(
    () => (episodes ? seriesAudioLanguagesOf(episodes) : fullCoverageOf(audioLanguagesOf(item))),
    [episodes, item],
  );
  const subtitleCoverage = useMemo(
    () => (episodes ? seriesSubtitleLanguagesOf(episodes) : fullCoverageOf(subtitleLanguagesOf(item))),
    [episodes, item],
  );

  if (isLoading) {
    return (
      <section
        className="pf-glass pf-glass--blur pf-media-langs pf-media-langs--loading"
        aria-busy="true"
      >
        <span className="pf-media-langs__hint">Cargando idiomas…</span>
      </section>
    );
  }

  if (downloadLanguage == null && audioCoverage.length === 0 && subtitleCoverage.length === 0) {
    return null;
  }

  return (
    <section className="pf-glass pf-glass--blur pf-media-langs" role="status">
      {downloadLanguage != null && (
        <p className="pf-media-langs__download">
          Descargado en <strong>{downloadLanguage}</strong>
        </p>
      )}

      {audioCoverage.length > 0 && (
        <LanguageChipRow label="Audio" coverage={audioCoverage} defaultLanguage={downloadLanguage} />
      )}

      {subtitleCoverage.length > 0 && (
        <LanguageChipRow label="Subtítulos" coverage={subtitleCoverage} defaultLanguage={downloadLanguage} />
      )}
    </section>
  );
}
