import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { StatusBadge } from '../../components/StatusBadge';
import { useDownloads, type DownloadItem } from '../../hooks/useDownloads';
import { tmdbPosterUrl } from '../../lib/domain/posterUrl';

// Home's "En camino" row (projector-feature-map.md §3 row 2, walkthrough §2's
// "EN CAMINO" - note it is NOT labeled "Descargando"). Reuses the Downloads
// screen's `useDownloads` hook verbatim (same Jellyseerr active-requests
// source + Radarr/Sonarr % correlation, projector-feature-map.md §9),
// filtered down to titles still in flight - "Disponible" means the request
// already finished and belongs on the Library/Trending rows instead. Like
// Continue Watching, this row has no loading/error UI of its own: it renders
// nothing until there's at least one still-downloading item.
const AVAILABLE_LABEL = 'Disponible';

function toDownloadingPosterItem(item: DownloadItem): PosterItem {
  return {
    // Detail's route param is a TMDB id (design.md §7); fall back to the
    // Jellyseerr request id on the rare malformed request with no tmdbId,
    // same fallback `useDownloads`'s own `toDownloadItem` uses for title.
    id: item.tmdbId != null ? String(item.tmdbId) : String(item.id),
    title: item.title,
    imageUrl: tmdbPosterUrl(item.posterPath),
    mediaType: item.mediaType,
    progressPercent: item.percent,
    badge: <StatusBadge variant="requesting" label={item.statusLabel.toUpperCase()} />,
  };
}

export function DownloadingRow() {
  const downloads = useDownloads();

  const items = downloads.items
    .filter((item) => item.statusLabel !== AVAILABLE_LABEL)
    .map(toDownloadingPosterItem);

  if (items.length === 0) return null;

  return (
    <Row
      title="En camino"
      items={items}
      isLoading={false}
      isError={false}
      onRetry={() => downloads.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage=""
    />
  );
}
