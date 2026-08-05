import { useMemo, useState } from 'react';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { audioLanguagesOf, defaultAudioLanguageOf, subtitleLanguagesOf } from './audioLanguages';
import { prioritizeLanguages } from './prioritizeLanguages';

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
// its own). `null`/`undefined` (not in the library yet, or a series with no
// playable episode) renders nothing, same as the line it replaces.

interface MediaLanguagesPanelProps {
  item: JellyfinItem | null | undefined;
  isLoading: boolean;
}

interface LanguageChipRowProps {
  label: string;
  languages: string[];
  defaultLanguage: string | null;
}

function LanguageChipRow({ label, languages, defaultLanguage }: LanguageChipRowProps) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = useMemo(
    () => prioritizeLanguages(languages, defaultLanguage, VISIBLE_CHIP_LIMIT),
    [languages, defaultLanguage],
  );
  const visible = expanded ? languages : shown;

  return (
    <div className="pf-media-langs__row">
      <span className="pf-media-langs__label">{label}</span>
      <ul className="pf-media-langs__chips">
        {visible.map((lang, index) => (
          <li key={`${lang}-${index}`} className="pf-media-langs__chip">
            {lang}
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

export function MediaLanguagesPanel({ item, isLoading }: MediaLanguagesPanelProps) {
  const downloadLanguage = useMemo(() => defaultAudioLanguageOf(item), [item]);
  const audioLanguages = useMemo(() => audioLanguagesOf(item), [item]);
  const subtitleLanguages = useMemo(() => subtitleLanguagesOf(item), [item]);

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

  if (downloadLanguage == null && audioLanguages.length === 0 && subtitleLanguages.length === 0) {
    return null;
  }

  return (
    <section className="pf-glass pf-glass--blur pf-media-langs" role="status">
      {downloadLanguage != null && (
        <p className="pf-media-langs__download">
          Descargado en <strong>{downloadLanguage}</strong>
        </p>
      )}

      {audioLanguages.length > 0 && (
        <LanguageChipRow label="Audio" languages={audioLanguages} defaultLanguage={downloadLanguage} />
      )}

      {subtitleLanguages.length > 0 && (
        <LanguageChipRow
          label="Subtítulos"
          languages={subtitleLanguages}
          defaultLanguage={downloadLanguage}
        />
      )}
    </section>
  );
}
