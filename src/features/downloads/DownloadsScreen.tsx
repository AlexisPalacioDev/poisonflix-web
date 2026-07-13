import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmOverlay } from '../../components/ConfirmOverlay';
import { Header } from '../../components/Header';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { StatusBadge, type StatusBadgeVariant } from '../../components/StatusBadge';
import { useCancelDownload } from '../../hooks/useCancelDownload';
import { useDownloads, type DownloadItem } from '../../hooks/useDownloads';
import { useAdultLibraryItems, useDeleteAdultItem } from '../../hooks/useAdultLibrary';
import { useAdultUnlocked } from '../../hooks/useAdultUnlocked';
import { useAuth } from '../../hooks/useAuth';
import { queryKeys } from '../../hooks/queryKeys';
import { displayTitle } from '../../lib/domain/displayTitle';
import { jellyfinPosterUrl, tmdbPosterUrl } from '../../lib/domain/posterUrl';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { PoisonMark } from '../onboarding/PoisonMark';
import './downloads.css';

// Downloads screen (projector-feature-map.md §9, walkthrough §14) - ported
// from `DownloadsScreen.kt`/`DownloadsViewModel.kt`: a dedicated grid of
// every active Jellyseerr request, distinct from Home's deferred "En camino"
// row. Each card shows its status pill + live download %; long-pressing a
// card (D-pad long-press on the native app, press-and-hold here via
// `PosterCard.onLongClick`) opens the cancel confirm.

function statusVariant(statusLabel: string): StatusBadgeVariant {
  // Green "available" treatment once done downloading; gold "in progress"
  // treatment for every other status (Pendiente/Descargando/Parcialmente
  // disponible) - mirrors the walkthrough's badge colors (§14).
  return statusLabel === 'Disponible' ? 'in-library' : 'requesting';
}

function toPosterItem(item: DownloadItem): PosterItem {
  return {
    // Detail's route param is the TMDB id (design.md §7); falls back to the
    // Jellyseerr request id on the rare item with no tmdbId, same as the
    // title fallback in useDownloads.
    id: String(item.tmdbId ?? item.id),
    title: item.title,
    imageUrl: tmdbPosterUrl(item.posterPath),
    progressPercent: item.percent,
    badge: <StatusBadge variant={statusVariant(item.statusLabel)} label={item.statusLabel.toUpperCase()} />,
  };
}

function toAdultPosterItem(item: JellyfinItem, token: string | null): PosterItem {
  return {
    id: item.Id,
    title: displayTitle(item.Name),
    imageUrl: jellyfinPosterUrl(item, token),
  };
}

export function DownloadsScreen() {
  const { items, isLoading, isError, refetch } = useDownloads();
  const cancelDownload = useCancelDownload();
  const queryClient = useQueryClient();

  // +18: adult titles live in the "Adultos" Jellyfin library (grabbed via
  // Prowlarr, never a Jellyseerr request), so they only appear here once the
  // PIN is unlocked - the one place to delete them straight through Jellyfin.
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  // Same admin-only gating as the library "Eliminar" flow on Detail
  // (security hardening): deleting straight through Jellyfin is a
  // destructive write, so it's hidden for non-admins here too - the PIN
  // unlock alone is not an authorization boundary.
  const isAdmin = session?.isAdmin === true;
  const adultUnlocked = useAdultUnlocked();
  const adultLibrary = useAdultLibraryItems();
  const deleteAdult = useDeleteAdultItem();
  const [pendingAdultDelete, setPendingAdultDelete] = useState<JellyfinItem | null>(null);

  const [pendingCancel, setPendingCancel] = useState<DownloadItem | null>(null);
  // Optimistically hidden request ids - removed the instant the user
  // confirms, ahead of the mutation settling / the next 15s poll.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<number>>(new Set());

  const visibleItems = items.filter((item) => !hiddenIds.has(item.id));

  function handleConfirmCancel() {
    const target = pendingCancel;
    if (!target) return;

    setPendingCancel(null);
    setHiddenIds((prev) => new Set(prev).add(target.id));

    // Even a request with no tmdbId is cancelled: the arr resolution no-ops,
    // but the Jellyseerr request is still deleted (so the card doesn't just
    // vanish from the UI while the download keeps running server-side).
    cancelDownload.mutate(
      { tmdbId: target.tmdbId, requestId: target.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: queryKeys.requests('all') });
          queryClient.invalidateQueries({ queryKey: queryKeys.downloadProgress() });
        },
        onError: () => {
          // The cancel never actually reached Jellyseerr - bring the card
          // back instead of leaving it permanently (and wrongly) hidden.
          setHiddenIds((prev) => {
            const next = new Set(prev);
            next.delete(target.id);
            return next;
          });
        },
      },
    );
  }

  return (
    <main className="pf-downloads">
      <Header />

      <div className="pf-downloads__header">
        <h1 className="pf-downloads__title">Descargas</h1>
        <button
          type="button"
          className="pf-downloads__refresh"
          onClick={() => refetch()}
          aria-label="Actualizar"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
            />
          </svg>
        </button>
      </div>

      {isLoading && (
        <div className="pf-downloads__grid" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="pf-skeleton pf-downloads__skeleton-card" />
          ))}
        </div>
      )}

      {isError && (
        <div className="pf-downloads__status pf-downloads__status--error" role="alert">
          <span>No se pudieron cargar las descargas.</span>
          <button type="button" className="pf-downloads__retry" onClick={() => refetch()}>
            Reintentar
          </button>
        </div>
      )}

      {!isLoading && !isError && visibleItems.length === 0 && (
        <div className="pf-downloads__empty">
          <PoisonMark className="pf-downloads__empty-mark" />
          <p>No hay nada descargándose ahora mismo.</p>
        </div>
      )}

      {!isLoading && !isError && visibleItems.length > 0 && (
        <div className="pf-downloads__grid">
          {visibleItems.map((item) => (
            <PosterCard
              key={item.id}
              item={toPosterItem(item)}
              onLongClick={() => setPendingCancel(item)}
            />
          ))}
        </div>
      )}

      {adultUnlocked && (adultLibrary.data?.length ?? 0) > 0 && (
        <section className="pf-downloads__adult" aria-label="+18">
          <h2 className="pf-downloads__adult-title">+18</h2>
          {isAdmin && <p className="pf-downloads__adult-hint">Mantené presionado un título para eliminarlo.</p>}
          <div className="pf-downloads__grid">
            {adultLibrary.data?.map((item) => (
              <PosterCard
                key={item.Id}
                item={toAdultPosterItem(item, token)}
                to="/downloads"
                onLongClick={isAdmin ? () => setPendingAdultDelete(item) : undefined}
              />
            ))}
          </div>
        </section>
      )}

      <ConfirmOverlay
        open={pendingCancel != null}
        title="Cancelar descarga"
        message={pendingCancel ? `¿Cancelar la descarga de "${pendingCancel.title}"?` : ''}
        confirmLabel="Sí, cancelar"
        dismissLabel="No, seguir"
        danger
        onConfirm={handleConfirmCancel}
        onDismiss={() => setPendingCancel(null)}
      />

      <ConfirmOverlay
        open={pendingAdultDelete != null}
        title="Eliminar +18"
        message={
          pendingAdultDelete
            ? `¿Eliminar "${displayTitle(pendingAdultDelete.Name)}"? Se borrará el archivo y no se puede deshacer.`
            : ''
        }
        confirmLabel="Sí, eliminar"
        dismissLabel="No, conservar"
        danger
        onConfirm={() => {
          const target = pendingAdultDelete;
          setPendingAdultDelete(null);
          if (target) deleteAdult.mutate(target.Id);
        }}
        onDismiss={() => setPendingAdultDelete(null)}
      />
    </main>
  );
}
