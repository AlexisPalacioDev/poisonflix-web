import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Header } from '../../components/Header';
import { useMovieDetail } from '../../hooks/useMovieDetail';
import { useRequestMedia } from '../../hooks/useRequestMedia';
import { jellyseerrStatusLabel, statusFromJellyseerrStatus, type TitleStatus } from '../../lib/domain/libraryIndex';
import { tmdbPosterUrl } from '../../lib/domain/posterUrl';
import './detail.css';

// Detail screen (design.md §7 `/detail/:id`, detail-request spec), ported
// from `DetailScreen.kt` + `DetailRepositoryImpl.requestMedia` (L120-134).
// Movies-only MVP (TV two-pane detail is deferred per the spec). `:id` is
// the TMDB id (design.md §7): entries reached from Home/Search both carry
// this id already; when a library item had no TMDB provider id, Home's
// fallback sends the raw Jellyfin id here instead - `useMovieDetail`
// tolerates a non-numeric/unknown id by surfacing the error state rather
// than crashing (flagged limitation, not a silent gap - see apply-progress).

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

export function DetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const tmdbId = id ?? '';

  const { detail, status, isLoading, isError, refetch } = useMovieDetail(tmdbId);
  const requestMutation = useRequestMedia();

  // Local override, set ONLY on a successful request response - the
  // detail-request spec's "no optimistic update" requirement means this
  // must never be set speculatively before the server confirms, and a
  // failed request must leave it untouched (so `displayStatus` falls back
  // to the still-unchanged `status` from `useMovieDetail`, which is exactly
  // `Requestable` in that failure case).
  const [overrideStatus, setOverrideStatus] = useState<TitleStatus | null>(null);

  // A different detail (route id changed) must not carry over a stale
  // override or a previous request's error/pending state.
  useEffect(() => {
    setOverrideStatus(null);
    requestMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmdbId]);

  const displayStatus = overrideStatus ?? status;

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

          {displayStatus && (
            <DetailAction
              status={displayStatus}
              isRequesting={requestMutation.isPending}
              onRequest={handleRequest}
              onPlay={(jellyfinItemId) => navigate(`/player/${jellyfinItemId}`)}
            />
          )}

          {requestMutation.isError && (
            <p className="pf-detail__error" role="alert">
              No se pudo enviar el pedido. Intentá de nuevo.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
