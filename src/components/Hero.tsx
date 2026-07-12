import { Link } from 'react-router-dom';
import './Hero.css';

// Featured hero banner for Home (visual redesign). This is the single biggest
// fix for the "empty black void" look: a large full-bleed backdrop that
// anchors the top of the page. It is a pure presentational component - the
// caller (HomeScreen) picks the featured title from the Library/Trending data
// it already fetched and maps it into this plain `HeroFeature` shape, so no
// API/playback logic lives here.
export interface HeroFeature {
  title: string;
  overview: string | null;
  backdropUrl: string | null;
  year: number | null;
  rating: number | null;
  /** Always present - routes to the Detail screen. */
  detailTo: string;
  /** Only set when the featured title is in the library and directly
   * playable; when null the hero shows "Ver detalle" as its primary action
   * instead of a "Reproducir" that would dead-end. */
  playTo: string | null;
}

export function HeroSkeleton() {
  return (
    <section className="pf-hero pf-hero--skeleton" aria-hidden="true">
      <div className="pf-hero__scrim" />
      <div className="pf-hero__content">
        <div className="pf-skeleton pf-hero__sk-title" />
        <div className="pf-skeleton pf-hero__sk-line" />
        <div className="pf-skeleton pf-hero__sk-line pf-hero__sk-line--short" />
        <div className="pf-hero__sk-actions">
          <div className="pf-skeleton pf-hero__sk-btn" />
          <div className="pf-skeleton pf-hero__sk-btn" />
        </div>
      </div>
    </section>
  );
}

export function Hero({ feature }: { feature: HeroFeature }) {
  return (
    <section className="pf-hero" aria-label={`Destacado: ${feature.title}`}>
      {feature.backdropUrl ? (
        <img className="pf-hero__backdrop" src={feature.backdropUrl} alt="" aria-hidden="true" />
      ) : (
        <div className="pf-hero__backdrop pf-hero__backdrop--fallback" aria-hidden="true" />
      )}
      <div className="pf-hero__scrim" />

      <div className="pf-hero__content">
        <span className="pf-hero__eyebrow">Destacado</span>
        <h1 className="pf-hero__title">{feature.title}</h1>

        <div className="pf-hero__meta">
          {feature.rating != null && (
            <span className="pf-hero__rating">★ {feature.rating.toFixed(1)}</span>
          )}
          {feature.year != null && <span>{feature.year}</span>}
        </div>

        {feature.overview && <p className="pf-hero__overview">{feature.overview}</p>}

        <div className="pf-hero__actions">
          {feature.playTo ? (
            <>
              <Link className="pf-btn pf-btn--play" to={feature.playTo}>
                <PlayIcon />
                Reproducir
              </Link>
              <Link className="pf-btn pf-btn--ghost" to={feature.detailTo}>
                Ver detalle
              </Link>
            </>
          ) : (
            <Link className="pf-btn pf-btn--gold" to={feature.detailTo}>
              Ver detalle
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}
