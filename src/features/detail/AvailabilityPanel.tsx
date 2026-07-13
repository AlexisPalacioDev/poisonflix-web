import { useAvailability } from '../../hooks/useAvailability';
import { RELEASE_LANGUAGE_LABELS } from '../../lib/domain/releaseLanguage';

// Pre-download availability panel (feature B): before the user hits "Pedir",
// show whether the title exists on the torrent indexers and in which languages,
// so a title that simply isn't out there — or is English-only — is visible up
// front instead of silently stalling in the download queue for days.

interface AvailabilityPanelProps {
  title: string;
  tmdbId: number | null;
}

export function AvailabilityPanel({ title, tmdbId }: AvailabilityPanelProps) {
  const { data, isLoading, isError } = useAvailability(title, tmdbId);

  if (isLoading) {
    return (
      <section className="pf-availability pf-availability--loading" aria-busy="true">
        <span className="pf-availability__label">Buscando en torrents…</span>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="pf-availability pf-availability--muted">
        <span className="pf-availability__label">No se pudo consultar la disponibilidad.</span>
      </section>
    );
  }

  if (!data || !data.found) {
    return (
      <section className="pf-availability pf-availability--none" role="status">
        <span className="pf-availability__label pf-availability__label--none">
          No encontrado en torrents
        </span>
      </section>
    );
  }

  return (
    <section className="pf-availability" role="status">
      <div className="pf-availability__head">
        <span className="pf-availability__label">Disponible en torrents</span>
        <span className="pf-availability__meta">
          {data.totalReleases} {data.totalReleases === 1 ? 'release' : 'releases'} · ▲ {data.maxSeeders} seeders
        </span>
      </div>
      <ul className="pf-availability__langs">
        {data.languages.map((lang) => (
          <li key={lang.language} className="pf-availability__chip">
            <span className="pf-availability__chip-name">{RELEASE_LANGUAGE_LABELS[lang.language]}</span>
            <span className="pf-availability__chip-count">
              {lang.count} · ▲{lang.maxSeeders}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
