import { useMemo } from 'react';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { MediaLanguagesPanel } from './MediaLanguagesPanel';
import { progressOf, type EpisodeProgress, type SeriesEpisode } from '../../hooks/useSeriesEpisodes';

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
// the below-title progress summary instead when the series has any episodes
// at all, whether or not an episode is already playable - simpler to
// implement and test on the web, and both walkthrough screenshots (§19/§20)
// show that summary alongside a playable poster anyway.
//
// Honesty rework (owner's live Bleach repro: Season 2 all read "En cola"
// while Sonarr's own queue held ONE completed record; a "Descargando · 20%"
// bar kept reading while nothing was moving): every level now says only what
// is actually true.
// - Per episode: `episodeStatusLine` distinguishes Available/Downloading (real
//   %)/Importing (done transferring, waiting on Sonarr's import step)/Queued
//   (waiting its turn, not started - the ONLY case that may say "En cola")/
//   Missing (nothing incoming)/NotMonitored (Sonarr itself isn't looking for
//   it) - see `useSeriesEpisodes.ts`'s `EpisodeStatus`. A per-record
//   `warning` (Sonarr's own `errorMessage`/`trackedDownloadStatus`) renders
//   inline instead of staying invisible.
// - Per season: completeness ("X de Y episodios") is never confused with
//   activity (an "⬇ N" badge only when that season has something actually
//   moving).
// - Per series: `SeriesProgressSummary` keeps "how much do I HAVE"
//   (completeness) strictly separate from "how much is currently HAPPENING"
//   (activity) - the owner's second complaint was these two fused into one
//   mislabeled bar. Zero activity is stated explicitly, never left silent.

interface SeriesTwoPaneProps {
  title: string;
  posterUrl: string | null;
  canPlay: boolean;
  onPlayFirstEpisode: () => void;
  seriesProgress: EpisodeProgress;
  // Poster-side language card source (owner asks #2/#4): the first playable
  // episode's raw Jellyfin item (a Series item itself carries no
  // MediaStreams - see DetailScreen's `mediaLanguagesItemId`).
  mediaLanguagesItem: JellyfinItem | null | undefined;
  isMediaLanguagesLoading: boolean;
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

/** Episodes currently moving through Sonarr in any way (downloading, importing or merely queued) - "activity", never confused with "completeness" (`availableCount`/`totalCount`). */
function activeCountOf(progress: EpisodeProgress): number {
  return progress.downloadingCount + progress.importingCount + progress.queuedCount;
}

function WarningNote({ warning }: { warning: string | null }) {
  if (!warning) return null;
  return (
    <span className="pf-episode-row__warning" role="alert">
      ⚠ {warning}
    </span>
  );
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
          <WarningNote warning={status.warning} />
        </span>
      );
    case 'Importing':
      return (
        <span className="pf-episode-row__status pf-episode-row__status--importing">
          Importando…
          <WarningNote warning={status.warning} />
        </span>
      );
    case 'Queued':
      // The ONLY status allowed to say "En cola" - it means what it says:
      // sitting in Sonarr's queue, not yet started (see `queueInfoFromRecord`
      // in useSeriesEpisodes.ts).
      return (
        <span className="pf-episode-row__status pf-episode-row__status--queued">
          En cola
          <WarningNote warning={status.warning} />
        </span>
      );
    case 'Missing':
      // Previously mislabeled "En cola" (owner's live Bleach repro: Season 2
      // read this for every episode while Sonarr's queue held a single
      // unrelated record) - nothing is incoming, so nothing should imply it is.
      return <span className="pf-episode-row__status pf-episode-row__status--missing">Falta</span>;
    case 'NotMonitored':
      return (
        <span className="pf-episode-row__status pf-episode-row__status--not-monitored">No se está buscando</span>
      );
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

/**
 * Series-level honesty (owner's second complaint): completeness ("tenés X de
 * Y episodios") and activity ("N descargas activas", or an explicit "no hay
 * nada bajando") are two different questions, rendered as two different
 * lines - never fused into one "Descargando · N%" bar that keeps reading a
 * stale completeness percentage under an activity label.
 */
function SeriesProgressSummary({ progress }: { progress: EpisodeProgress }) {
  if (progress.totalCount === 0) return null;

  const completenessPercent = Math.floor((progress.availableCount / progress.totalCount) * 100);
  const activeCount = activeCountOf(progress);

  return (
    <div className="pf-series-detail__progress">
      <div className="pf-series-detail__progress-row">
        <span className="pf-series-detail__progress-track">
          <span className="pf-series-detail__progress-fill" style={{ width: `${completenessPercent}%` }} />
        </span>
        <span className="pf-series-detail__progress-label">
          {progress.availableCount} de {progress.totalCount} episodios
        </span>
      </div>

      {/* No `role="status"` here: the media-languages card right below already
          owns that role in this same pane (`MediaLanguagesPanel`), and tests
          query it by role - a second `status` region would make that query
          ambiguous. This line is still always-visible plain text either way,
          which is the actual honesty requirement (owner: "si NO hay nada
          descargando, la UI tiene que decirlo"). */}
      <p className="pf-series-detail__activity">
        {activeCount > 0
          ? `${activeCount} ${activeCount === 1 ? 'descarga activa' : 'descargas activas'}`
          : 'No hay descargas activas en este momento'}
      </p>

      {progress.warningCount > 0 && (
        <p className="pf-series-detail__warning" role="alert">
          {progress.warningCount === 1
            ? '1 descarga necesita atención'
            : `${progress.warningCount} descargas necesitan atención`}
        </p>
      )}
    </div>
  );
}

export function SeriesTwoPane({
  title,
  posterUrl,
  canPlay,
  onPlayFirstEpisode,
  seriesProgress,
  mediaLanguagesItem,
  isMediaLanguagesLoading,
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

  // Per-season completeness/activity (owner ask: "por temporada, cuántos
  // episodios tenés de cuántos, y si hay algo bajando ahí") - same `progressOf`
  // the series-level summary uses, just scoped to one season's episode subset.
  const progressBySeason = useMemo(() => {
    const map = new Map<number, EpisodeProgress>();
    for (const [season, episodes] of episodesBySeason) {
      map.set(season, progressOf(episodes));
    }
    return map;
  }, [episodesBySeason]);

  // Full flat episode list, ALL seasons - the media-languages panel's
  // per-series coverage (owner ask #4) must count against every episode the
  // series has, not just whichever season happens to be selected.
  const allEpisodes = useMemo(() => Array.from(episodesBySeason.values()).flat(), [episodesBySeason]);

  return (
    <div className="pf-series-detail">
      <div className="pf-glass pf-glass--blur pf-series-detail__left">
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

        <SeriesProgressSummary progress={seriesProgress} />

        <MediaLanguagesPanel
          item={mediaLanguagesItem}
          episodes={allEpisodes}
          isLoading={isMediaLanguagesLoading}
        />

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
            const progress = progressBySeason.get(season);
            const total = progress?.totalCount ?? 0;
            const active = progress ? activeCountOf(progress) : 0;
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
                    {progress?.availableCount ?? 0} de {total} {total === 1 ? 'episodio' : 'episodios'}
                    {active > 0 && <span className="pf-season-row__activity"> · ⬇ {active}</span>}
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
