import { useEffect, useRef, useState } from 'react';
import { ThumbButtons } from './ThumbButtons';
import { useQueryClient } from '@tanstack/react-query';
import { useUserPlaylists } from '../../hooks/useUserPlaylists';
import { addToPlaylist, createPlaylist } from '../../api/playlists';
import { setFavorite } from '../../api/jellyfin';
import { getMusicJob, requestDownload, type RequestDownloadParams } from '../../api/music';
import { queryKeys } from '../../hooks/queryKeys';

// The universal per-song "⋮" overflow menu, used by EVERY song row (search,
// recommendations, library "Canciones", album, playlist, track detail). Play
// stays inline as the primary action; every secondary action lives here so no
// row sprouts a wall of buttons and they all look identical.
//
// Actions shown are driven by which callbacks the row passes:
//  - itemId present (in library)  -> Cola, Favorito, playlist add, and (if
//    onDelete) "Borrar de la biblioteca".
//  - itemId null (a search result not downloaded yet) -> "Descargar", plus
//    playlist/favorite that transparently DOWNLOAD first (the worker coalesces
//    duplicates), poll to the Jellyfin itemId, then act.
//  - onRemoveFromPlaylist present (playlist rows) -> "Quitar de la playlist".

const POLL_MS = 1500;
const POLL_TRIES = 160; // ~4 min ceiling for a download to settle

function KebabGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="12" cy="5" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="19" r="1.8" fill="currentColor" />
    </svg>
  );
}

export interface MusicRowMenuProps {
  /** The track's YouTube id, when known — enables the 👍/👎 pair. Library
   *  rows never matched to a videoId simply omit it. */
  videoId?: string | null;
  title: string;
  /** Jellyfin itemId when the track is in the library, else null (search result). */
  itemId: string | null;
  /** Params to acquire the track when an action needs it downloaded first. */
  downloadParams?: RequestDownloadParams;
  /** Fire the shared per-row download (drives the row's own state). */
  onDownload?: () => void;
  /** Enqueue this track. Receives the Jellyfin itemId when the track is in the
   *  library, or null for a search hit that will be queued as a stream — a
   *  not-yet-downloaded track is playable, so it must be queueable too. */
  onEnqueue?: (itemId: string | null) => void;
  /** Delete the track's file from the library (library rows). Confirms first. */
  onDelete?: (itemId: string) => void | Promise<void>;
  /** Remove the track from the current playlist (playlist rows only). */
  onRemoveFromPlaylist?: () => void | Promise<void>;
}

export function MusicRowMenu({
  title,
  videoId,
  itemId,
  downloadParams,
  onDownload,
  onEnqueue,
  onDelete,
  onRemoveFromPlaylist,
}: MusicRowMenuProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'playlists'>('menu');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const { items: playlists, isLoading } = useUserPlaylists(open && view === 'playlists');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => void (mountedRef.current = false), []);

  const close = () => {
    setOpen(false);
    setView('menu');
    setCreating(false);
    setName('');
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(t);
  }, [status]);

  // Resolve the library itemId, downloading + polling first when needed. A job
  // can report "done" before Jellyfin has scanned the file in, so we wait for
  // the jellyfinItemId itself (the worker resolves it lazily) rather than for
  // "done", giving up only on an explicit failure or the timeout.
  const ensureItemId = async (): Promise<string | null> => {
    if (itemId) return itemId;
    if (!downloadParams) return null;
    const res = await requestDownload(downloadParams);
    for (let i = 0; i < POLL_TRIES; i++) {
      let job;
      try {
        job = await getMusicJob(res.jobId);
      } catch {
        job = null;
      }
      if (job?.jellyfinItemId) return job.jellyfinItemId;
      if (job?.state === 'failed') return null;
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!mountedRef.current) return null;
    }
    return null;
  };

  const runAcquiringAction = async (
    pending: string,
    action: (resolvedId: string) => Promise<void>,
    done: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setStatus(pending);
    try {
      const resolved = await ensureItemId();
      if (!resolved) {
        if (mountedRef.current) setStatus('No se pudo. Probá de nuevo.');
        return;
      }
      await action(resolved);
      if (mountedRef.current) {
        setStatus(done);
        close();
      }
    } catch {
      if (mountedRef.current) setStatus('No se pudo. Probá de nuevo.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const acquiring = !itemId;

  const handleFavorite = () =>
    runAcquiringAction(
      acquiring ? 'Descargando y marcando…' : 'Agregando a favoritos…',
      (resolved) => setFavorite(resolved, true),
      'Agregado a favoritos',
    );

  const handleAdd = (playlistId: string, playlistName: string) =>
    runAcquiringAction(
      acquiring ? `Descargando y agregando a ${playlistName}…` : `Agregando a ${playlistName}…`,
      async (resolved) => {
        await addToPlaylist(playlistId, resolved);
        queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylist(playlistId) });
      },
      `Se agregó a ${playlistName}`,
    );

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    return runAcquiringAction(
      acquiring ? `Descargando y creando "${trimmed}"…` : `Creando "${trimmed}"…`,
      async (resolved) => {
        await createPlaylist(trimmed, resolved);
      },
      `Se creó "${trimmed}" con la canción`,
    );
  };

  const handleDelete = async () => {
    if (busy || !itemId || !onDelete) return;
    const ok = window.confirm(
      `¿Borrar "${title}" de la biblioteca?\n\nSe elimina el archivo y no se puede deshacer.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await onDelete(itemId);
      close();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleRemoveFromPlaylist = async () => {
    if (busy || !onRemoveFromPlaylist) return;
    setBusy(true);
    try {
      await onRemoveFromPlaylist();
      close();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className="pf-music__addpl">
      <button
        type="button"
        className="pf-music__addpl-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Más opciones para ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <KebabGlyph />
      </button>

      {open && (
        <>
          <button
            type="button"
            className="pf-music__addpl-backdrop"
            aria-label="Cerrar menú"
            onClick={close}
          />
          <div className="pf-music__addpl-menu" role="menu" aria-label={`Opciones para ${title}`}>
            {view === 'menu' ? (
              <ul className="pf-music__addpl-list">
                {videoId && (
                  <li>
                    <ThumbButtons videoId={videoId} title={title} />
                  </li>
                )}
                {onEnqueue && (
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      className="pf-music__addpl-item"
                      onClick={() => {
                        onEnqueue(itemId);
                        close();
                      }}
                    >
                      Agregar a la cola
                    </button>
                  </li>
                )}
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    className="pf-music__addpl-item"
                    onClick={() => setView('playlists')}
                    disabled={busy}
                  >
                    Agregar a playlist
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    className="pf-music__addpl-item"
                    onClick={handleFavorite}
                    disabled={busy}
                  >
                    ♥ Favorito
                  </button>
                </li>
                {onRemoveFromPlaylist && (
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      className="pf-music__addpl-item"
                      onClick={handleRemoveFromPlaylist}
                      disabled={busy}
                    >
                      Quitar de la playlist
                    </button>
                  </li>
                )}
                {!itemId && onDownload && (
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      className="pf-music__addpl-item"
                      onClick={() => {
                        onDownload();
                        close();
                      }}
                    >
                      Descargar
                    </button>
                  </li>
                )}
                {itemId && onDelete && (
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      className="pf-music__addpl-item pf-music__addpl-item--danger"
                      onClick={handleDelete}
                      disabled={busy}
                    >
                      Borrar de la biblioteca
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <>
                <p className="pf-music__addpl-heading">Agregar a playlist</p>
                {isLoading ? (
                  <p className="pf-music__addpl-empty">Cargando…</p>
                ) : playlists.length === 0 ? (
                  <p className="pf-music__addpl-empty">Todavía no tenés playlists.</p>
                ) : (
                  <ul className="pf-music__addpl-list">
                    {playlists.map((pl) => (
                      <li key={pl.Id}>
                        <button
                          type="button"
                          role="menuitem"
                          className="pf-music__addpl-item"
                          onClick={() => handleAdd(pl.Id, pl.Name)}
                          disabled={busy}
                        >
                          {pl.Name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {creating ? (
                  <div className="pf-music__addpl-create">
                    <input
                      ref={nameInputRef}
                      type="text"
                      className="pf-music__addpl-input"
                      placeholder="Nombre de la playlist"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreate();
                      }}
                      aria-label="Nombre de la nueva playlist"
                    />
                    <button
                      type="button"
                      className="pf-music__addpl-item pf-music__addpl-item--primary"
                      onClick={handleCreate}
                      disabled={busy || name.trim().length === 0}
                    >
                      Crear
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="pf-music__addpl-item pf-music__addpl-item--new"
                    onClick={() => setCreating(true)}
                    disabled={busy}
                  >
                    Crear nueva…
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}

      <span className="pf-music__addpl-status" role="status" aria-live="polite">
        {status ?? ''}
      </span>
    </div>
  );
}
