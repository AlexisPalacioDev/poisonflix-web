import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '../../components/Header';
import { useAuth } from '../../hooks/useAuth';
import { usePlaylistTracks } from '../../hooks/usePlaylistTracks';
import { useUserPlaylists } from '../../hooks/useUserPlaylists';
import { removeFromPlaylist, deletePlaylist, deletePlaylistWithTracks } from '../../api/playlists';
import { deleteItem } from '../../api/jellyfin';
import { queryKeys } from '../../hooks/queryKeys';
import { resolveCoverUrl } from '../../lib/domain/posterUrl';
import { audioItemToTrack } from '../../lib/domain/musicTrack';
import { CoverImage } from './CoverImage';
import { PlayButton } from './PlayButton';
import { MusicRowMenu } from './MusicRowMenu';
import { useMusicPlayer } from './MusicPlayerProvider';
import './music.css';

// User playlist detail (/musica/playlist/:id): a header (name, "N temas",
// "Reproducir" → playNow from track 0, "Eliminar lista") and the track list —
// each row an icon play button plus a "Quitar" that removes that exact entry by
// its PlaylistItemId. The playlist name comes from the user's playlist list
// (already cached when arriving from the tab; fetched on a direct load).

function trackDuration(ticks: number | null | undefined): string {
  if (!ticks || ticks <= 0) return '';
  const seconds = Math.floor(ticks / 10_000_000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function trackCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'tema' : 'temas'}`;
}

export function PlaylistScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const userId = session?.jellyfinUserId ?? '';

  const { items, isLoading, isError, refetch } = usePlaylistTracks(id);
  const { items: playlists } = useUserPlaylists();
  const { playNow, enqueue, current, isPlaying, toggle } = useMusicPlayer();
  const [deleting, setDeleting] = useState(false);

  const tracks = useMemo(() => items.map((item) => audioItemToTrack(item, token)), [items, token]);

  const playlistName = playlists.find((p) => p.Id === id)?.Name ?? 'Playlist';
  const cover = items[0] ? resolveCoverUrl(items[0], token, 600) : null;

  const handleRemove = async (entryId: string | null | undefined) => {
    if (!id || !entryId) return;
    await removeFromPlaylist(id, entryId);
    queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylist(id) });
  };

  const handleDelete = async () => {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      await deletePlaylist(id);
      queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylists(userId) });
      navigate('/musica');
    } catch {
      setDeleting(false);
    }
  };

  // Delete the playlist AND every song in it from the library (files and all).
  // Irreversible, so it's gated behind an explicit confirm.
  const handleDeleteAll = async () => {
    if (!id || deleting || tracks.length === 0) return;
    const n = tracks.length;
    const ok = window.confirm(
      `¿Eliminar la playlist "${playlistName}" y sus ${n} ${n === 1 ? 'canción' : 'canciones'} de la biblioteca?\n\nSe borran los archivos. Esta acción no se puede deshacer.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await deletePlaylistWithTracks(
        id,
        tracks.map((t) => t.itemId),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylists(userId) });
      navigate('/musica');
    } catch {
      setDeleting(false);
    }
  };

  // Delete a single song's file from the library. Confirmed inside the row menu.
  const handleDeleteSong = async (itemId: string) => {
    if (!id) return;
    await deleteItem(itemId);
    queryClient.invalidateQueries({ queryKey: queryKeys.userPlaylist(id) });
  };

  return (
    <main className="pf-music pf-music--detail">
      <Header />

      <div className="pf-music__detail-head">
        <button
          type="button"
          className="pf-music__back"
          onClick={() => navigate(-1)}
          aria-label="Volver"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false">
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <div className="pf-music__detail-cover">
          <CoverImage src={cover} />
        </div>

        <div className="pf-music__detail-meta">
          <span className="pf-music__detail-kicker">Playlist</span>
          <h1 className="pf-music__detail-title">{playlistName}</h1>
          <p className="pf-music__detail-artist">{trackCountLabel(tracks.length)}</p>

          <div className="pf-music__detail-actions">
            <button
              type="button"
              className="pf-music__play-album"
              onClick={() => playNow(tracks, 0)}
              disabled={tracks.length === 0}
            >
              Reproducir
            </button>
            <button
              type="button"
              className="pf-music__action"
              onClick={handleDelete}
              disabled={deleting}
            >
              Eliminar lista
            </button>
            <button
              type="button"
              className="pf-music__action pf-music__action--danger"
              onClick={handleDeleteAll}
              disabled={deleting || tracks.length === 0}
            >
              Eliminar lista y temas
            </button>
          </div>
        </div>
      </div>

      <section className="pf-music__section" aria-label="Temas de la playlist">
        {isLoading ? (
          <p className="pf-music__empty">Cargando…</p>
        ) : isError ? (
          <p role="alert" className="pf-music__empty">
            No se pudo cargar la playlist.{' '}
            <button type="button" className="pf-music__link-btn" onClick={() => refetch()}>
              Reintentar
            </button>
          </p>
        ) : tracks.length === 0 ? (
          <p className="pf-music__empty">Esta playlist está vacía.</p>
        ) : (
          <ul className="pf-music__list">
            {items.map((item, index) => {
              const track = tracks[index];
              return (
                <li key={item.PlaylistItemId ?? track.itemId} className="pf-music__row">
                  <span className="pf-music__track-no">{index + 1}</span>
                  <div className="pf-music__art">
                    <CoverImage src={track.coverUrl} loading="lazy" />
                  </div>
                  <Link
                    to={`/musica/track/${track.itemId}`}
                    className="pf-music__info pf-music__track-link"
                    aria-label={`Ver ${track.title}`}
                  >
                    <span className="pf-music__title">{track.title}</span>
                    {track.artist && <span className="pf-music__sub">{track.artist}</span>}
                  </Link>
                  {item.RunTimeTicks != null && (
                    <span className="pf-music__dur">{trackDuration(item.RunTimeTicks)}</span>
                  )}
                  <PlayButton
                    active={current?.itemId === track.itemId}
                    isPlaying={isPlaying}
                    onClick={() =>
                      current?.itemId === track.itemId ? toggle() : playNow(tracks, index)
                    }
                    label={`Reproducir ${track.title}`}
                  />
                  <MusicRowMenu
                    title={track.title}
                    itemId={track.itemId}
                    onEnqueue={() => enqueue(track)}
                    onDelete={handleDeleteSong}
                    onRemoveFromPlaylist={() => handleRemove(item.PlaylistItemId)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
