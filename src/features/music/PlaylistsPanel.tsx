import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { useUserPlaylists } from '../../hooks/useUserPlaylists';
import { createPlaylist } from '../../api/playlists';
import { queryKeys } from '../../hooks/queryKeys';
import { resolveCoverUrl } from '../../lib/domain/posterUrl';
import { CoverImage } from './CoverImage';

// "Playlists" browse tab: the user's own playlists as cover cards (each → its
// detail page) plus a "Crear playlist" button that reveals an inline name input.
// Covers reuse the playlist item's own Primary image (Jellyfin composes it from
// the first track) via the shared cover-art fallback, degrading to the ♪
// placeholder through CoverImage. Every control is a native <button>/<a>/<input>
// for D-pad reach.

export function PlaylistsPanel({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const userId = session?.jellyfinUserId ?? '';

  const { items: playlists, isLoading, isError } = useUserPlaylists(active);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await createPlaylist(trimmed);
      queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylists(userId) });
      setName('');
      setCreating(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="tabpanel" aria-label="Playlists">
      <div className="pf-music__playlists-head">
        {creating ? (
          <div className="pf-music__addpl-create">
            <input
              ref={inputRef}
              type="text"
              className="pf-music__addpl-input"
              placeholder="Nombre de la playlist"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
              aria-label="Nombre de la nueva playlist"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <button
              type="button"
              className="pf-music__action pf-music__action--primary"
              onClick={handleCreate}
              disabled={busy || name.trim().length === 0}
            >
              Crear
            </button>
            <button
              type="button"
              className="pf-music__action"
              onClick={() => {
                setCreating(false);
                setName('');
              }}
            >
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="pf-music__action pf-music__action--primary"
            onClick={() => setCreating(true)}
          >
            Crear playlist
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="pf-music__empty">Cargando…</p>
      ) : isError ? (
        <p role="alert" className="pf-music__empty">
          No se pudieron cargar las playlists.
        </p>
      ) : playlists.length === 0 ? (
        <p className="pf-music__empty">Todavía no creaste ninguna playlist.</p>
      ) : (
        <div className="pf-music__grid">
          {playlists.map((pl) => (
            <Link key={pl.Id} to={`/musica/playlist/${pl.Id}`} className="pf-music__card">
              <div className="pf-music__card-art">
                <CoverImage src={resolveCoverUrl(pl, token)} loading="lazy" />
              </div>
              <span className="pf-music__card-title">{pl.Name}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
