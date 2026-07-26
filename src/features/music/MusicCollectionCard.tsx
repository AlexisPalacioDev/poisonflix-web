import type { MusicAlbumResult, MusicPlaylistResult } from '../../api/schemas/music';
import { usePlaylistDownload } from '../../hooks/usePlaylistDownload';
import { CoverImage } from './CoverImage';
import { DownloadIcon } from './DownloadIcon';
import { trackCountLabel } from './format';

// An album or playlist hit rendered as a card. Unlike a song (which plays on
// click), a collection downloads as a whole batch: the "Descargar" button fires
// the browseId / playlistId download and the card then shows batch progress in
// place (reusing `usePlaylistDownload`). Two layouts: `row` sits inside the
// search results list, `rail` sits in the horizontal "Recomendados" rail. Every
// control is a native <button> for D-pad reach; the cover is an external YouTube
// URL used directly (never the Jellyfin proxy).

type Collection = MusicAlbumResult | MusicPlaylistResult;

export interface MusicCollectionCardProps {
  item: Collection;
  layout?: 'row' | 'rail';
}

function isAlbum(item: Collection): item is MusicAlbumResult {
  return item.type === 'album';
}

export function MusicCollectionCard({ item, layout = 'row' }: MusicCollectionCardProps) {
  const { submit, submitting, submitError, batch, complete } = usePlaylistDownload();

  const kind = isAlbum(item) ? 'Álbum' : 'Playlist';
  const title = item.title ?? (isAlbum(item) ? 'Álbum sin título' : 'Playlist sin título');
  const author = isAlbum(item) ? item.artist ?? null : item.author ?? null;
  const yearLabel = isAlbum(item) && item.year != null ? String(item.year) : null;
  const countLabel = trackCountLabel(item.trackCount);
  const subtitle = [author, countLabel, yearLabel].filter(Boolean).join(' · ') || kind;

  const settled = batch ? batch.done + batch.failed : 0;
  const total = batch?.total ?? 0;
  const inProgress = Boolean(batch) && !complete;
  const busy = submitting || inProgress;

  const handleDownload = () => {
    if (busy) return;
    if (isAlbum(item)) submit({ browseId: item.browseId });
    else submit({ playlistId: item.playlistId });
  };

  const buttonLabel = complete
    ? 'Descargado'
    : submitting
      ? 'Enviando…'
      : inProgress
        ? `${settled}/${total || '…'}`
        : 'Descargar';

  const cover = <CoverImage src={item.thumbnailUrl} loading="lazy" />;

  const status = submitError ? (
    <p role="alert" className="pf-music__coll-error">
      No se pudo iniciar la descarga.
    </p>
  ) : batch && total > 0 ? (
    <p className="pf-music__coll-status" aria-live="polite">
      {complete
        ? `Listo: ${batch.done} de ${total}${batch.failed > 0 ? ` · ${batch.failed} con error` : ''}`
        : `Descargando ${settled} de ${total}…`}
    </p>
  ) : null;

  if (layout === 'rail') {
    return (
      <div className="pf-music__rec pf-music__rec--coll">
        <div className="pf-music__rec-art">{cover}</div>
        <span className="pf-music__rec-kind">{kind}</span>
        <span className="pf-music__rec-title">{title}</span>
        <span className="pf-music__rec-sub">{subtitle}</span>
        <button
          type="button"
          className="pf-music__play-icon pf-music__coll-btn"
          onClick={handleDownload}
          disabled={busy || complete}
          title={buttonLabel}
          aria-label={`Descargar ${kind.toLowerCase()} ${title}`}
        >
          <DownloadIcon />
        </button>
        {status}
      </div>
    );
  }

  return (
    <li className="pf-music__row pf-music__row--coll">
      <div className="pf-music__art">{cover}</div>
      <div className="pf-music__info">
        <span className="pf-music__title">
          {title}
          <span className="pf-music__badge">{kind}</span>
        </span>
        <span className="pf-music__sub">{subtitle}</span>
        {status}
      </div>
      <button
        type="button"
        className="pf-music__play-icon"
        onClick={handleDownload}
        disabled={busy || complete}
        title={buttonLabel}
        aria-label={`Descargar ${kind.toLowerCase()} ${title}`}
      >
        <DownloadIcon />
      </button>
    </li>
  );
}
