import { AvailabilityPanel } from './AvailabilityPanel';
import type { SeriesEpisode } from '../../hooks/useSeriesEpisodes';

// TV series two-pane detail (projector-feature-map.md §7 "TV SERIES layout",
// walkthrough §19/§20), ported from `SeriesDetailContent`/`SeasonRow`/
// `EpisodeRow` (`DetailScreen.kt:396-995`). Only rendered for an `InLibrary`
// series (DetailScreen.tsx branches on that before reaching this component) -
// a series that isn't in the library yet keeps the single-hero layout
// (Pedir/Descargando), same as a movie.
//
// Deviation from the Kotlin reference (noted, not silent): the Kotlin poster
// "takes over" with a percent readout instead of the play button when no
// episode is playable yet (`canPlaySeries` false). This port always renders
// the below-title progress bar instead when `seriesProgress` is non-null,
// whether or not an episode is already playable - simpler to implement and
// test on the web, and both walkthrough screenshots (§19/§20) show that bar
// alongside a playable poster anyway.

interface SeriesTwoPaneProps {
  title: string;
  posterUrl: string | null;
  canPlay: boolean;
  onPlayFirstEpisode: () => void;
  seriesProgress: number | null;
  availabilityTitle: string;
  availabilityTmdbId: number | null;
  // Status-aware secondary action (feature-map §7): "Cancelar" while
  // `Requesting` (still downloading/partially available), "Eliminar" once
  // fully `InLibrary` - the label/handler/disabled/error are pre-resolved by
  // `DetailScreen` (same status branch the movie/single-hero layout uses),
  // so this component stays a dumb renderer of whichever action applies.
  // `secondaryLabel: null` (non-admin, security hardening: library delete is
  // admin-only) means "render no secondary action at all" - the two-pane's
  // secondary is always "Eliminar", never "Cancelar", so there is no
  // non-admin-visible fallback action here the way the movie hero has one.
  secondaryLabel: string | null;
  secondaryDisabled: boolean;
  secondaryError: string | null;
  onSecondaryAction: () => void;
  seasons: number[];
  episodesBySeason: Map<number, SeriesEpisode[]>;
  selectedSeason: number | null;
  onSelectSeason: (season: number) => void;
  isLoadingEpisodes: boolean;
  onPlayEpisode: (jellyfinItemId: string) => void;
}

function episodeStatusLine(status: SeriesEpisode['status']) {
  switch (status.kind) {
    case 'Available':
      return <span className="pf-episode-row__status pf-episode-row__status--available">Disponible</span>;
    case 'Downloading':
      return (
        <span className="pf-episode-row__status pf-episode-row__status--downloading">
          <span className="pf-episode-row__mini-track">
            <span
              className="pf-episode-row__mini-fill"
              style={{ width: `${Math.min(100, Math.max(0, status.percent))}%` }}
            />
          </span>
          Descargando · {Math.round(status.percent)}%
        </span>
      );
    case 'Missing':
      return <span className="pf-episode-row__status pf-episode-row__status--missing">En cola</span>;
  }
}

function EpisodeRow({
  episode,
  onPlayEpisode,
}: {
  episode: SeriesEpisode;
  onPlayEpisode: (jellyfinItemId: string) => void;
}) {
  const available = episode.status.kind === 'Available' ? episode.status : null;

  return (
    <button
      type="button"
      className="pf-episode-row"
      onClick={() => available && onPlayEpisode(available.jellyfinItemId)}
    >
      <span className="pf-episode-row__still">
        {episode.stillUrl ? (
          <img src={episode.stillUrl} alt="" />
        ) : (
          <span className="pf-episode-row__still-placeholder" aria-hidden="true" />
        )}
      </span>
      <span className="pf-episode-row__body">
        <span className="pf-episode-row__title">
          S{episode.seasonNumber}·E{episode.episodeNumber} — {episode.title}
        </span>
        {episodeStatusLine(episode.status)}
      </span>
    </button>
  );
}

export function SeriesTwoPane({
  title,
  posterUrl,
  canPlay,
  onPlayFirstEpisode,
  seriesProgress,
  availabilityTitle,
  availabilityTmdbId,
  secondaryLabel,
  secondaryDisabled,
  secondaryError,
  onSecondaryAction,
  seasons,
  episodesBySeason,
  selectedSeason,
  onSelectSeason,
  isLoadingEpisodes,
  onPlayEpisode,
}: SeriesTwoPaneProps) {
  const currentSeason = selectedSeason ?? seasons[0] ?? null;
  const seasonEpisodes = currentSeason != null ? (episodesBySeason.get(currentSeason) ?? []) : [];

  return (
    <div className="pf-series-detail">
      <div className="pf-series-detail__left">
        <div className="pf-series-detail__poster">
          {posterUrl ? (
            <img src={posterUrl} alt="" />
          ) : (
            <span className="pf-detail__poster-placeholder" aria-hidden="true">
              {title.charAt(0).toUpperCase()}
            </span>
          )}
          {canPlay && (
            <button
              type="button"
              className="pf-series-detail__play"
              onClick={onPlayFirstEpisode}
              aria-label="Reproducir"
            >
              ▶
            </button>
          )}
        </div>

        <h1 className="pf-series-detail__title">{title}</h1>

        {seriesProgress != null && (
          <div className="pf-series-detail__progress">
            <span className="pf-series-detail__progress-track">
              <span className="pf-series-detail__progress-fill" style={{ width: `${seriesProgress}%` }} />
            </span>
            <span className="pf-series-detail__progress-label">Descargando · {seriesProgress}%</span>
          </div>
        )}

        <AvailabilityPanel title={availabilityTitle} tmdbId={availabilityTmdbId} />

        {secondaryLabel != null && (
          <button
            type="button"
            className="pf-detail__action pf-series-detail__delete"
            onClick={onSecondaryAction}
            disabled={secondaryDisabled}
          >
            {secondaryLabel}
          </button>
        )}

        {secondaryError && (
          <p className="pf-detail__error" role="alert">
            {secondaryError}
          </p>
        )}

        <h2 className="pf-series-detail__seasons-label">TEMPORADAS</h2>
        <ul className="pf-series-detail__seasons">
          {seasons.map((season) => {
            const count = episodesBySeason.get(season)?.length ?? 0;
            const isSelected = season === currentSeason;
            return (
              <li key={season}>
                <button
                  type="button"
                  className={`pf-season-row${isSelected ? ' pf-season-row--selected' : ''}`}
                  onClick={() => onSelectSeason(season)}
                >
                  <span className="pf-season-row__title">Temporada {season}</span>
                  <span className="pf-season-row__count">
                    {count} {count === 1 ? 'episodio' : 'episodios'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="pf-series-detail__right">
        <h2 className="pf-series-detail__season-heading">
          {currentSeason != null ? `Temporada ${currentSeason}` : 'Episodios'}
        </h2>
        {isLoadingEpisodes && seasonEpisodes.length === 0 ? (
          <p className="pf-series-detail__hint">Cargando episodios…</p>
        ) : seasonEpisodes.length === 0 ? (
          <p className="pf-series-detail__hint">Todavía no hay episodios disponibles</p>
        ) : (
          <ul className="pf-episode-list">
            {seasonEpisodes.map((episode) => (
              <li key={`${episode.seasonNumber}-${episode.episodeNumber}`}>
                <EpisodeRow episode={episode} onPlayEpisode={onPlayEpisode} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
