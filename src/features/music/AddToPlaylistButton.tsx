import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { useAuth } from '../../hooks/useAuth';
import { useUserPlaylists } from '../../hooks/useUserPlaylists';
import { addToPlaylist, createPlaylist } from '../../api/playlists';
import { queryKeys } from '../../hooks/queryKeys';

// "Agregar a playlist" control for a song row / track detail: a "+" button that
// opens a small menu listing the user's playlists (add on click) plus a "Crear
// nueva…" inline-name path. Everything is a native <button>/<input> so it's
// reachable by keyboard and the webOS D-pad. Escape and the click-outside
// backdrop are owned by the shared `OverlayShell` (design D:
// `sdd/mobile-music-overhaul`) rather than a local `window` listener. A brief
// Spanish confirmation is announced via an aria-live region.
//
// The panel is portalled TOGETHER with the backdrop (via `anchorRef`), not
// left as a separate local sibling: the parent row's `:hover` state applies a
// `transform` (`.pf-music__row:hover`), which creates its OWN stacking
// context for the whole row - a panel left in place would stay trapped
// inside it while a backdrop portalled alone to `document.body` escaped to
// the root context, letting the backdrop paint OVER the entire row while
// hovered (transform-created contexts behave as z-index: 0). See
// `OverlayShell`'s module doc comment for the general fix - same root cause
// as the confirmed Header hamburger-menu blocker.
//
// The playlists query is gated on `open`, so a closed menu costs nothing.

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface AddToPlaylistButtonProps {
  /** Jellyfin Audio item id to add. */
  songId: string;
  /** Song title, used for the accessible label + confirmation copy. */
  songTitle: string;
}

export function AddToPlaylistButton({ songId, songTitle }: AddToPlaylistButtonProps) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const { items: playlists, isLoading } = useUserPlaylists(open);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Anchor for the portalled dropdown panel - see the comment above `close`
  // for why the panel can no longer rely on a local `position: relative`
  // wrapper once it's portalled away from it.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setCreating(false);
    setName('');
  };

  // Focus the name field when the create form opens.
  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  // Auto-clear the confirmation so it doesn't linger.
  useEffect(() => {
    if (!confirmation) return;
    const t = setTimeout(() => setConfirmation(null), 3000);
    return () => clearTimeout(t);
  }, [confirmation]);

  const invalidatePlaylists = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylists(userId) });
  };

  const handleAdd = async (playlistId: string, playlistName: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await addToPlaylist(playlistId, songId);
      queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylist(playlistId) });
      invalidatePlaylists();
      setConfirmation(`Se agregó a ${playlistName}`);
      close();
    } catch {
      setConfirmation('No se pudo agregar. Probá de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await createPlaylist(trimmed, songId);
      invalidatePlaylists();
      setConfirmation(`Se creó "${trimmed}" con la canción`);
      close();
    } catch {
      setConfirmation('No se pudo crear la playlist. Probá de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pf-music__addpl">
      <button
        ref={triggerRef}
        type="button"
        className="pf-music__addpl-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Agregar ${songTitle} a una playlist`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <PlusGlyph />
      </button>

      {open && (
        <OverlayShell
          variant="menu"
          onDismiss={close}
          className="pf-music__addpl-backdrop"
          ariaLabel="Cerrar menú"
          anchorRef={triggerRef}
        >
          <div className="pf-music__addpl-menu" role="menu" aria-label="Agregar a playlist">
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
          </div>
        </OverlayShell>
      )}

      <span className="pf-music__addpl-status" role="status" aria-live="polite">
        {confirmation ?? ''}
      </span>
    </div>
  );
}
