import { useMemo } from 'react';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { audioLanguagesOf, defaultAudioLanguageOf, subtitleLanguagesOf } from './audioLanguages';

// Poster-side language card (owner asks #2 + #4): what the file actually
// downloaded/plays in by default, plus the full audio/subtitle breakdown
// embedded in it. One compact card next to the cover instead of the old
// scattered "Audio disponible" text line + the (now admin-only) torrents
// block - see detail.css's `.pf-glass` for the shared card treatment.
//
// `item` is the raw Jellyfin item (movie's own, or - for a series - the
// first playable episode's, since a Series item carries no MediaStreams of
// its own). `null`/`undefined` (not in the library yet, or a series with no
// playable episode) renders nothing, same as the line it replaces.

interface MediaLanguagesPanelProps {
  item: JellyfinItem | null | undefined;
  isLoading: boolean;
}

export function MediaLanguagesPanel({ item, isLoading }: MediaLanguagesPanelProps) {
  const downloadLanguage = useMemo(() => defaultAudioLanguageOf(item), [item]);
  const audioLanguages = useMemo(() => audioLanguagesOf(item), [item]);
  const subtitleLanguages = useMemo(() => subtitleLanguagesOf(item), [item]);

  if (isLoading) {
    return (
      <section className="pf-glass pf-media-langs pf-media-langs--loading" aria-busy="true">
        <span className="pf-media-langs__hint">Cargando idiomas…</span>
      </section>
    );
  }

  if (downloadLanguage == null && audioLanguages.length === 0 && subtitleLanguages.length === 0) {
    return null;
  }

  return (
    <section className="pf-glass pf-media-langs" role="status">
      {downloadLanguage != null && (
        <p className="pf-media-langs__download">
          Descargado en <strong>{downloadLanguage}</strong>
        </p>
      )}

      {audioLanguages.length > 0 && (
        <div className="pf-media-langs__row">
          <span className="pf-media-langs__label">Audio</span>
          <ul className="pf-media-langs__chips">
            {audioLanguages.map((lang) => (
              <li key={lang} className="pf-media-langs__chip">
                {lang}
              </li>
            ))}
          </ul>
        </div>
      )}

      {subtitleLanguages.length > 0 && (
        <div className="pf-media-langs__row">
          <span className="pf-media-langs__label">Subtítulos</span>
          <ul className="pf-media-langs__chips">
            {subtitleLanguages.map((lang) => (
              <li key={lang} className="pf-media-langs__chip">
                {lang}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
