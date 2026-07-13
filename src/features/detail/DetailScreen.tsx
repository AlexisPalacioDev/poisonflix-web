import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Header } from '../../components/Header';
import { ConfirmOverlay } from '../../components/ConfirmOverlay';
import { AvailabilityPanel } from './AvailabilityPanel';
import { SeriesTwoPane } from './SeriesTwoPane';
import { audioLanguagesOf } from './audioLanguages';
import { useTitleDetail, type MediaType } from '../../hooks/useTitleDetail';
import { useRequestMedia } from '../../hooks/useRequestMedia';
import { useLibraryItem } from '../../hooks/useLibraryItem';
import { useSeriesLibraryId } from '../../hooks/useSeriesLibraryId';
import { useSeriesEpisodes } from '../../hooks/useSeriesEpisodes';
import { useDownloadProgress } from '../../hooks/useDownloadProgress';
import { useCancelDownload } from '../../hooks/useCancelDownload';
import { useAuth } from '../../hooks/useAuth';
import { queryKeys } from '../../hooks/queryKeys';
import { deleteRadarrMovie, deleteSonarrSeries, getRadarrMovies, getSonarrSeries } from '../../api/arr';
import { getRequests } from '../../api/jellyseerr';
import { jellyseerrStatusLabel, statusFromJellyseerrStatus, type TitleStatus } from '../../lib/domain/libraryIndex';
import { tmdbPosterUrl } from '../../lib/domain/posterUrl';
import './detail.css';

// Detail screen (design.md §7 `/detail/:id`, detail-request spec + Detail
// screen enhancements per projector-feature-map.md §7, walkthrough §15/§19/
// §20), ported from `DetailScreen.kt` + `DetailViewModel.kt` +
// `DetailRepositoryImpl.requestMedia` (L120-134) + `EpisodeRepositoryImpl.kt`.
// `:id` is the TMDB id (design.md §7): entries reached from Home/Search both
// carry this id already; when a library item had no TMDB provider id, Home's
// fallback sends the raw Jellyfin id here instead - `useTitleDetail`
// tolerates a non-numeric/unknown id by surfacing the error state rather
// than crashing (flagged limitation, not a silent gap - see apply-progress).
//
// MOVIES (and a not-yet-in-library SERIES) keep the single-hero layout. An
// `InLibrary` SERIES switches to the two-pane layout (`SeriesTwoPane`):
// a whole-series id 500s on Jellyfin's PlaybackInfo (only episodes are
// playable), so the series-level "Reproducir" plays the FIRST Available
// episode instead.

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface DetailActionProps {
  status: TitleStatus;
  isRequesting: boolean;
  onRequest: () => void;
  onPlay: (jellyfinItemId: string) => void;
}

/**
 * Context-aware primary action (detail-request spec's Requirement 1):
 * `InLibrary` -> "Reproducir" (no "Pedir" shown at all); `Requestable` ->
 * enabled "Pedir"; `Requesting` -> disabled label showing the current
 * Jellyseerr status, preventing a duplicate submission.
 *
 * An `InLibrary` SERIES never reaches this component - `DetailScreen` routes
 * that combination to `SeriesTwoPane` instead (a whole-series id 500s on
 * Jellyfin's PlaybackInfo, so its own in-poster play button targets the
 * first Available episode, not this button).
 */
function DetailAction({ status, isRequesting, onRequest, onPlay }: DetailActionProps) {
  switch (status.kind) {
    case 'InLibrary':
      return (
        <button
          type="button"
          className="pf-detail__action pf-detail__action--play"
          onClick={() => onPlay(status.jellyfinItemId)}
        >
          Reproducir
        </button>
      );
    case 'Requesting':
      return (
        <button type="button" className="pf-detail__action pf-detail__action--requesting" disabled>
          {jellyseerrStatusLabel(status.jellyseerrStatus)}
        </button>
      );
    case 'Requestable':
      return (
        <button
          type="button"
          className="pf-detail__action pf-detail__action--request"
          onClick={onRequest}
          disabled={isRequesting}
        >
          {isRequesting ? 'Enviando…' : 'Pedir'}
        </button>
      );
  }
}

function ProgressHint({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="pf-detail__progress" role="status">
      <span className="pf-detail__progress-track">
        <span className="pf-detail__progress-fill" style={{ width: `${clamped}%` }} />
      </span>
      <span className="pf-detail__progress-label">Descargando · {Math.round(clamped)}%</span>
    </div>
  );
}

export function DetailScreen() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tmdbId = id ?? '';
  // `?type=tv` disambiguates the TMDB id (see useTitleDetail). Absent/anything
  // else -> movie, so existing movie links keep working unchanged.
  const mediaType: MediaType = searchParams.get('type') === 'tv' ? 'tv' : 'movie';

  const { detail, status, isLoading, isError, refetch } = useTitleDetail(tmdbId, mediaType);
  const requestMutation = useRequestMedia(mediaType);

  // Library delete (Radarr/Sonarr/Jellyfin "Eliminar") is admin-only (security
  // hardening: the BFF now returns 403 for a non-admin DELETE/PUT on
  // radarr/sonarr) - gated here purely for UX, since the BFF re-enforces this
  // server-side regardless. "Cancelar" stays visible for everyone: the BFF's
  // /bff/cancel authorizes owner-or-admin, not admin-only.
  const { session } = useAuth();
  const isAdmin = session?.isAdmin === true;

  // Local override, set ONLY on a successful request response - the
  // detail-request spec's "no optimistic update" requirement means this
  // must never be set speculatively before the server confirms, and a
  // failed request must leave it untouched (so `displayStatus` falls back
  // to the still-unchanged `status` from `useTitleDetail`, which is exactly
  // `Requestable` in that failure case).
  const [overrideStatus, setOverrideStatus] = useState<TitleStatus | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const displayStatus = overrideStatus ?? status;

  // Series episode list (two-pane's data source). The series-level Jellyfin
  // item id is resolved INDEPENDENTLY of the title-level `status` here: that
  // status comes from `useLibraryRow`, which fetches movies only, so no
  // series ever resolves to `InLibrary` through it (live bug the coordinator
  // caught). `useSeriesLibraryId` runs its own `IncludeItemTypes=Series`
  // fetch and matches by tmdbId/title+year, so a series in the Jellyfin
  // library is detected regardless of what Jellyseerr reports its status as
  // (walkthrough §20: a "Parcialmente disponible" series still browses its
  // episodes). tvdbId is Sonarr's fallback identity for the episode merge.
  const tvdbId = detail?.mediaInfo?.tvdbId ?? null;
  const { seriesJellyfinItemId } = useSeriesLibraryId(
    detail?.id ?? null,
    detail?.title ?? null,
    parseYear(detail?.releaseDate),
    mediaType === 'tv',
  );
  const seriesEpisodes = useSeriesEpisodes(tmdbId, seriesJellyfinItemId, tvdbId);

  // Audio disponible line (movie-only per the walkthrough - a Jellyfin
  // Series item carries no MediaStreams of its own, only its episodes do).
  const libraryItemId =
    mediaType === 'movie' && displayStatus?.kind === 'InLibrary' ? displayStatus.jellyfinItemId : null;
  const { item: libraryItem } = useLibraryItem(libraryItemId);
  const audioLanguages = useMemo(() => audioLanguagesOf(libraryItem), [libraryItem]);

  // Live download-% polling (feature-map §7): movie/not-yet-in-library-series
  // hero shows it on the primary action; the two-pane's own seriesProgress
  // (derived from the merged episode list) covers the series case.
  const { progressByTmdbId } = useDownloadProgress();
  const moviePercent = detail ? (progressByTmdbId.get(detail.id) ?? null) : null;

  // Cancel needs the Jellyseerr REQUEST id (not the media id `mediaInfo.id`
  // carries) - resolved from the active-requests list, the same source
  // Downloads' `useDownloads` reads, so this shares its cache entry.
  const requestsQuery = useQuery({
    queryKey: queryKeys.requests('all'),
    queryFn: () => getRequests('all', 50, 0),
    enabled: displayStatus?.kind === 'Requesting',
    staleTime: 5_000,
  });
  const cancelDownload = useCancelDownload();

  // Radarr/Sonarr identity resolution + delete (feature-map §7 "Eliminar").
  // 401-gated in this dev environment (no provisioned API key) - unit-tested,
  // not E2E-verifiable live; failure surfaces `deleteMutation.isError`
  // instead of crashing.
  const deleteMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!detail) throw new Error('No se pudo identificar el título para borrarlo.');
      if (mediaType === 'tv') {
        const seriesList = await getSonarrSeries();
        const match = seriesList.find(
          (s) => s.tmdbId === detail.id || (tvdbId != null && s.tvdbId === tvdbId),
        );
        if (!match) throw new Error('No se pudo identificar el título para borrarlo.');
        await deleteSonarrSeries(match.id, true);
      } else {
        const movies = await getRadarrMovies();
        const match = movies.find((m) => m.tmdbId === detail.id);
        if (!match) throw new Error('No se pudo identificar el título para borrarlo.');
        await deleteRadarrMovie(match.id, true);
      }
    },
  });

  // A different detail (route id changed) must not carry over a stale
  // override, season selection, confirm state, or a previous request's
  // error/pending state.
  useEffect(() => {
    setOverrideStatus(null);
    setSelectedSeason(null);
    setShowDeleteConfirm(false);
    setShowCancelConfirm(false);
    requestMutation.reset();
    deleteMutation.reset();
    cancelDownload.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmdbId, mediaType]);

  // Default season selection (two-pane): the lowest season with an Available
  // episode, else the lowest season overall - only once, on first arrival.
  useEffect(() => {
    if (selectedSeason == null && seriesEpisodes.defaultSeason != null) {
      setSelectedSeason(seriesEpisodes.defaultSeason);
    }
  }, [seriesEpisodes.defaultSeason, selectedSeason]);

  const handleRequest = () => {
    const numericId = Number(tmdbId);
    requestMutation.mutate(numericId, {
      onSuccess: (response) => {
        // Requirement 3 (detail-request spec): reflect `response.media.status`,
        // never an assumed local value.
        setOverrideStatus(statusFromJellyseerrStatus(response.media.status));
      },
      // No onError handler needed: leaving `overrideStatus` untouched IS the
      // "no optimistic change on failure" behavior - `displayStatus` simply
      // falls back to `status` (still `Requestable`), and
      // `requestMutation.isError` alone drives the error message below.
    });
  };

  const goToPlayer = (jellyfinItemId: string) => navigate(`/player/${jellyfinItemId}`);

  const handleDeleteConfirm = () => {
    setShowDeleteConfirm(false);
    deleteMutation.mutate(undefined, { onSuccess: () => navigate(-1) });
  };

  const handleCancelConfirm = () => {
    setShowCancelConfirm(false);
    if (!detail) return;
    const requestId = requestsQuery.data?.results.find((r) => r.media.tmdbId === detail.id)?.id ?? -1;
    cancelDownload.mutate({ tmdbId: detail.id, requestId }, { onSuccess: () => navigate(-1) });
  };

  if (isLoading) {
    return (
      <main className="pf-detail">
        <Header />
        <p className="pf-detail__status">Cargando…</p>
      </main>
    );
  }

  if (isError || !detail) {
    return (
      <main className="pf-detail">
        <Header />
        <div className="pf-detail__status pf-detail__status--error" role="alert">
          <span>No se pudo cargar el detalle.</span>
          <button type="button" className="pf-detail__retry" onClick={() => refetch()}>
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  const year = parseYear(detail.releaseDate);
  const runtime = formatRuntime(detail.runtime);
  const backdropUrl = tmdbPosterUrl(detail.backdropPath, 'w1280');
  const posterUrl = tmdbPosterUrl(detail.posterPath, 'w500');

  // Trigger: a SERIES whose Jellyfin series id resolves (i.e. it has an
  // episode browser to show), independent of the Jellyseerr status. Movies
  // never resolve one (the resolver is gated on `mediaType === 'tv'`), so
  // they always keep the single-pane hero.
  const isSeriesTwoPane = mediaType === 'tv' && seriesJellyfinItemId != null;
  const firstAvailableEpisode = seriesEpisodes.episodes.find((episode) => episode.status.kind === 'Available');
  const canPlaySeries = firstAvailableEpisode != null;

  const deleteErrorMessage = deleteMutation.isError ? 'No se pudo eliminar el título. Intentá de nuevo.' : null;
  const cancelErrorMessage = cancelDownload.isError ? 'No se pudo cancelar la descarga. Intentá de nuevo.' : null;

  // Series two-pane's secondary action is ALWAYS "Eliminar", never "Cancelar".
  // Ground truth (docs/projector-walkthrough.md §19: Hellsing "Descargando ·
  // 90%" -> "Eliminar") settles the ambiguity in feature-map §7's abstract
  // "Requesting -> Cancelar" rule: reaching the two-pane means the series has a
  // resolved Jellyfin library id (playable episodes), which is definitionally
  // `InLibrary` (feature-map §1 "MediaRef.Jellyfin -> InLibrary") -> Eliminar,
  // even while more episodes are still downloading. A series that is ONLY
  // requested (no Jellyfin episodes yet) never reaches the two-pane and keeps
  // the movie/single-hero branch's `Requesting -> Cancelar` path below.
  const seriesSecondaryLabel = isAdmin ? (deleteMutation.isPending ? 'Eliminando…' : 'Eliminar') : null;
  const seriesSecondaryDisabled = deleteMutation.isPending;
  const seriesSecondaryError = deleteErrorMessage;
  const onSeriesSecondaryAction = () => setShowDeleteConfirm(true);

  return (
    <main className="pf-detail">
      <Header />

      {backdropUrl && (
        <div
          className="pf-detail__backdrop"
          style={{ backgroundImage: `url(${backdropUrl})` }}
          aria-hidden="true"
        />
      )}

      {isSeriesTwoPane ? (
        <div className="pf-detail__content pf-detail__content--series">
          <SeriesTwoPane
            title={detail.title}
            posterUrl={posterUrl}
            canPlay={canPlaySeries}
            onPlayFirstEpisode={() => {
              if (firstAvailableEpisode?.status.kind === 'Available') {
                goToPlayer(firstAvailableEpisode.status.jellyfinItemId);
              }
            }}
            seriesProgress={seriesEpisodes.seriesProgress}
            availabilityTitle={detail.title}
            availabilityTmdbId={detail.id}
            secondaryLabel={seriesSecondaryLabel}
            secondaryDisabled={seriesSecondaryDisabled}
            secondaryError={seriesSecondaryError}
            onSecondaryAction={onSeriesSecondaryAction}
            seasons={seriesEpisodes.seasons}
            episodesBySeason={seriesEpisodes.episodesBySeason}
            selectedSeason={selectedSeason}
            onSelectSeason={setSelectedSeason}
            isLoadingEpisodes={seriesEpisodes.isLoading}
            onPlayEpisode={goToPlayer}
          />
        </div>
      ) : (
        <div className="pf-detail__content">
          <div className="pf-detail__poster">
            {posterUrl ? (
              <img src={posterUrl} alt="" />
            ) : (
              <span className="pf-detail__poster-placeholder" aria-hidden="true">
                {detail.title.charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <div className="pf-detail__info">
            <h1 className="pf-detail__title">{detail.title}</h1>

            <div className="pf-detail__meta">
              {detail.voteAverage != null && (
                <span className="pf-detail__rating">★ {detail.voteAverage.toFixed(1)}</span>
              )}
              {year != null && <span>{year}</span>}
              {runtime && <span>{runtime}</span>}
            </div>

            {detail.overview && <p className="pf-detail__overview">{detail.overview}</p>}

            {audioLanguages.length > 0 && (
              <p className="pf-detail__audio" role="status">
                Audio disponible: {audioLanguages.join(' · ')}
              </p>
            )}

            <AvailabilityPanel title={detail.title} tmdbId={detail.id} />

            {displayStatus && (
              <DetailAction
                status={displayStatus}
                isRequesting={requestMutation.isPending}
                onRequest={handleRequest}
                onPlay={goToPlayer}
              />
            )}

            {displayStatus?.kind === 'Requesting' && moviePercent != null && (
              <ProgressHint percent={moviePercent} />
            )}

            {requestMutation.isError && (
              <p className="pf-detail__error" role="alert">
                No se pudo enviar el pedido. Intentá de nuevo.
              </p>
            )}

            {displayStatus?.kind === 'InLibrary' && isAdmin && (
              <button
                type="button"
                className="pf-detail__secondary"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Eliminando…' : 'Eliminar'}
              </button>
            )}

            {displayStatus?.kind === 'Requesting' && (
              <button
                type="button"
                className="pf-detail__secondary"
                onClick={() => setShowCancelConfirm(true)}
                disabled={cancelDownload.isPending}
              >
                {cancelDownload.isPending ? 'Cancelando…' : 'Cancelar'}
              </button>
            )}

            {deleteErrorMessage && (
              <p className="pf-detail__error" role="alert">
                {deleteErrorMessage}
              </p>
            )}

            {cancelErrorMessage && (
              <p className="pf-detail__error" role="alert">
                {cancelErrorMessage}
              </p>
            )}
          </div>
        </div>
      )}

      <ConfirmOverlay
        open={showDeleteConfirm}
        title={`Eliminar «${detail.title}»`}
        message="Se eliminará el archivo y el registro. Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        dismissLabel="Cancelar"
        danger
        onConfirm={handleDeleteConfirm}
        onDismiss={() => setShowDeleteConfirm(false)}
      />

      <ConfirmOverlay
        open={showCancelConfirm}
        title={`Cancelar «${detail.title}»`}
        message="Se detiene la descarga y se borra el pedido. Para volver a descargarlo, buscalo y pedilo de nuevo."
        confirmLabel="Sí, cancelar"
        dismissLabel="No, seguir"
        onConfirm={handleCancelConfirm}
        onDismiss={() => setShowCancelConfirm(false)}
      />
    </main>
  );
}
