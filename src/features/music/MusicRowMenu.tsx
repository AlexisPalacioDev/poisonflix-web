import { useEffect, useRef, useState } from 'react';
import { ThumbButtons } from './ThumbButtons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { useUserPlaylists } from '../../hooks/useUserPlaylists';
import { addToPlaylist, createPlaylist } from '../../api/playlists';
import { setFavorite } from '../../api/jellyfin';
import { getMusicJob, requestDownload, type RequestDownloadParams } from '../../api/music';
import { queryKeys } from '../../hooks/queryKeys';
import { addTracksToJam, listJams } from '../../api/jam';

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
  /** Ride along with a thumb vote so "Tus me gusta" renders a track, not an id.
   *  Optional: a row that does not know them still votes fine, it just stores
   *  less. */
  artist?: string | null;
  coverUrl?: string | null;
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
  artist,
  coverUrl,
  itemId,
  downloadParams,
  onDownload,
  onEnqueue,
  onDelete,
  onRemoveFromPlaylist,
}: MusicRowMenuProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'playlists' | 'jams'>('menu');

  // Only rooms this user has actually joined can receive a track; a pending
  // invitation is not a queue you may write to.
  const jamsQuery = useQuery({ queryKey: queryKeys.jamList(), queryFn: listJams });
  const myJams = (jamsQuery.data ?? []).filter((entry) => entry.myRole?.acceptedAt != null);
  const [addingToJam, setAddingToJam] = useState(false);

  const addToJam = async (jamId: string) => {
    if (!videoId || addingToJam) return;
    setAddingToJam(true);
    try {
      await addTracksToJam(jamId, [
        {
          itemId: itemId ?? videoId,
          title,
          artist: artist ?? null,
          coverUrl: coverUrl ?? null,
          videoId,
          // A Jam plays on other people's devices, which have no claim on this
          // user's Jellyfin session — so the queue carries the shared preview
          // stream rather than a per-user library URL.
          streamUrl: `/bff/music/stream?videoId=${encodeURIComponent(videoId)}&source=ytmusic`,
        },
      ]);
      close();
    } catch {
      /* the row stays open; the failure is visible as nothing happening */
    } finally {
      setAddingToJam(false);
    }
  };
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const { items: playlists, isLoading } = useUserPlaylists(open && view === 'playlists');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => void (mountedRef.current = false), []);
  // Anchor for the portalled dropdown panel - see the comment above `close`
  // for why the panel can no longer rely on this row's own local
  // `position: relative` wrapper once it's portalled away from it.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setView('menu');
    setCreating(false);
    setName('');
  };

  // Escape, backdrop click, focus return, and body scroll-lock are owned by
  // the shared `OverlayShell` below (design D: `sdd/mobile-music-overhaul`),
  // replacing the local `window` listener this component used to have.
  //
  // The panel is portalled TOGETHER with the backdrop (via `anchorRef`), not
  // left as a separate local sibling: this row's own `:hover` state applies a
  // `transform` (`.pf-music__row:hover`), which creates its OWN stacking
  // context for the whole row - a panel left in place would stay trapped
  // inside it while a backdrop portalled alone to `document.body` escaped to
  // the root context. A transform-created context behaves as z-index: 0
  // there, so the backdrop (an explicit positive z-index) would paint OVER
  // the entire row - including the panel - while it's hovered, hiding every
  // item behind it. See `OverlayShell`'s module doc comment for the general
  // fix (unconfirmed suspicion from the audit that found the Header blocker;
  // fixed the same way as a precaution since it's the same root cause).

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
        ref={triggerRef}
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
        <OverlayShell
          variant="menu"
          onDismiss={close}
          className="pf-music__addpl-backdrop"
          ariaLabel="Cerrar menú"
          anchorRef={triggerRef}
        >
          <div className="pf-music__addpl-menu" role="menu" aria-label={`Opciones para ${title}`}>
            {view === 'menu' ? (
              <ul className="pf-music__addpl-list">
                {videoId && (
                  <li>
                    <ThumbButtons
                      videoId={videoId}
                      title={title}
                      artist={artist}
                      thumbnailUrl={coverUrl}
                    />
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
                {/* Until this existed a Jam had no way to get music into it
                    from the app at all — the queue could only be filled
                    through the API, so a room the owner created sat empty and
                    the feature looked broken. Adding from the song you are
                    already looking at is where it belongs. */}
                {videoId && myJams.length > 0 && (
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      className="pf-music__addpl-item"
                      disabled={addingToJam}
                      onClick={() => {
                        if (myJams.length === 1) {
                          addToJam(myJams[0].jam.id);
                        } else {
                          setView('jams');
                        }
                      }}
                    >
                      {myJams.length === 1
                        ? `Agregar a ${myJams[0].jam.name}`
                        : 'Agregar a una Jam'}
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
            ) : view === 'jams' ? (
              <ul className="pf-music__addpl-list">
                {myJams.map((entry) => (
                  <li key={entry.jam.id}>
                    <button
                      type="button"
                      role="menuitem"
                      className="pf-music__addpl-item"
                      disabled={addingToJam}
                      onClick={() => addToJam(entry.jam.id)}
                    >
                      {entry.jam.name}
                    </button>
                  </li>
                ))}
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
        </OverlayShell>
      )}

      <span className="pf-music__addpl-status" role="status" aria-live="polite">
        {status ?? ''}
      </span>
    </div>
  );
}
