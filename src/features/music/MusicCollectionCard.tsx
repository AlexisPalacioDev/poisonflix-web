import type { MusicAlbumResult, MusicPlaylistResult } from '../../api/schemas/music';
import type { CollectionRef } from '../../api/music';
import { usePlaylistDownload } from '../../hooks/usePlaylistDownload';
import { CoverImage } from './CoverImage';
import { DownloadIcon } from './DownloadIcon';
import { useState } from 'react';
import { trackCountLabel } from './format';

// An album or playlist hit rendered as a card. "Descargar" fires the whole
// browseId / playlistId batch and the card shows its progress in place (reusing
// `usePlaylistDownload`); "Reproducir" and "Agregar a la cola" resolve the
// collection's tracks first and stream them, so a collection no longer has to be
// downloaded before it can be heard. Two layouts: `row` sits inside the search
// results list, `rail` sits in the horizontal recommendations rail. Every
// control is a native <button> for D-pad reach; the cover is an external YouTube
// URL used directly (never the Jellyfin proxy).

type Collection = MusicAlbumResult | MusicPlaylistResult;

export interface MusicCollectionCardProps {
  item: Collection;
  layout?: 'row' | 'rail';
  /** Resolve the collection's tracks and play them now. Omitted where a card is
   *  purely a download target, which keeps its single button. The returned
   *  promise drives this card's pending state. */
  onPlay?: (ref: CollectionRef) => Promise<void>;
  /** Same, but appended to the queue instead of replacing it. */
  onEnqueue?: (ref: CollectionRef) => Promise<void>;
}

function isAlbum(item: Collection): item is MusicAlbumResult {
  return item.type === 'album';
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

// A list with a + on it: "add these to what is already lined up".
// Shown while a collection's track list is being resolved: a 300-track
// playlist takes a moment, and an inert-looking button reads as broken.
function SpinnerGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
      className="pf-music__spinner"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function QueueGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M4 7h11M4 12h11M4 17h7M17 14v6M14 17h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function MusicCollectionCard({
  item,
  layout = 'row',
  onPlay,
  onEnqueue,
}: MusicCollectionCardProps) {
  const { submit, submitting, submitError, batch, complete } = usePlaylistDownload();
  // 'play' | 'queue' | null — which of this card's actions is resolving.
  const [pending, setPending] = useState<'play' | 'queue' | null>(null);
  const [resolveError, setResolveError] = useState(false);

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

  const collectionRef = isAlbum(item) ? { browseId: item.browseId } : { playlistId: item.playlistId };

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

  // Play / queue only appear when the screen wired them up: a collection used
  // purely as a download target (the batch cards) keeps its single button.
  const runCollection = (action: 'play' | 'queue', run: (ref: CollectionRef) => Promise<void>) => {
    if (pending) return;
    setPending(action);
    setResolveError(false);
    run(collectionRef)
      .catch(() => setResolveError(true))
      .finally(() => setPending(null));
  };

  const playControls = (onPlay || onEnqueue) && (
    <>
      {onPlay && (
        <button
          type="button"
          className="pf-music__play-icon"
          onClick={() => runCollection('play', onPlay)}
          disabled={pending !== null}
          title={`Reproducir ${kind.toLowerCase()}`}
          aria-label={`Reproducir ${kind.toLowerCase()} ${title}`}
        >
          {pending === 'play' ? <SpinnerGlyph /> : <PlayGlyph />}
        </button>
      )}
      {onEnqueue && (
        <button
          type="button"
          className="pf-music__play-icon pf-music__play-icon--ghost"
          onClick={() => runCollection('queue', onEnqueue)}
          disabled={pending !== null}
          title="Agregar a la cola"
          aria-label={`Agregar ${kind.toLowerCase()} ${title} a la cola`}
        >
          {pending === 'queue' ? <SpinnerGlyph /> : <QueueGlyph />}
        </button>
      )}
    </>
  );

  const status = resolveError ? (
    <p role="alert" className="pf-music__coll-error">
      No se pudieron cargar los temas.
    </p>
  ) : submitError ? (
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
        {/* The kind tag and the controls live ON the artwork, the way a song
            card's play disc already does. Below it they made this card two
            lines taller than every song beside it in the same rail, and left
            the download button floating under the artist name with nothing to
            belong to. */}
        <div className="pf-music__rec-art">
          {cover}
          <span className="pf-music__rec-kind">{kind}</span>
          <div className="pf-music__coll-actions pf-music__coll-actions--rail">
            {playControls}
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
          </div>
        </div>
        <span className="pf-music__rec-title">{title}</span>
        <span className="pf-music__rec-sub">{subtitle}</span>
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
      {playControls}
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
