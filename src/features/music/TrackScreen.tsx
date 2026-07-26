import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Header } from '../../components/Header';
import { useAuth } from '../../hooks/useAuth';
import { useTrack } from '../../hooks/useTrack';
import { useArtistSongs } from '../../hooks/useArtistSongs';
import { deleteItem } from '../../api/jellyfin';
import { resolveCoverUrl } from '../../lib/domain/posterUrl';
import { audioItemToTrack } from '../../lib/domain/musicTrack';
import { CoverImage } from './CoverImage';
import { PlayButton } from './PlayButton';
import { AddToPlaylistButton } from './AddToPlaylistButton';
import { MusicRowMenu } from './MusicRowMenu';
import { useMusicPlayer } from './musicPlayerCore';
import './music.css';

// Track detail (/musica/track/:id): the Spotify-style page a song row opens to.
// A large cover + metadata header (title, artist(s), album, genre, year,
// duration), then the actions — play the single track (playNow), push it onto
// the queue (enqueue), and cross-links to the artist and album pages built from
// the item's own `ArtistItems`/`AlbumId`. webOS-safe: navigations are real
// <Link>s and plays are <button>s, so every control is natively focusable.

function trackDuration(ticks: number | null | undefined): string {
  if (!ticks || ticks <= 0) return '';
  const seconds = Math.floor(ticks / 10_000_000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TrackScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const { item, isLoading, isError, refetch } = useTrack(id);
  const { playNow, enqueue, current, isPlaying, toggle } = useMusicPlayer();

  const track = useMemo(() => (item ? audioItemToTrack(item, token) : null), [item, token]);

  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!track || deleting) return;
    const ok = window.confirm(
      `¿Borrar "${track.title}" de la biblioteca?\n\nSe elimina el archivo y no se puede deshacer.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteItem(track.itemId);
      navigate('/musica');
    } catch {
      setDeleting(false);
    }
  };

  const cover = item ? resolveCoverUrl(item, token, 600) : null;
  const artistNames =
    item?.ArtistItems?.map((a) => a.Name).join(', ') ?? item?.Artists?.join(', ') ?? item?.AlbumArtist ?? null;
  const artistId = item?.ArtistItems?.[0]?.Id ?? null;
  // Primary artist name for the "Más de {artista}" header — the first credited
  // artist, falling back to the joined credit so the header always reads.
  const primaryArtistName = item?.ArtistItems?.[0]?.Name ?? artistNames ?? null;

  // "Más de {artista}": the same artist's other songs from the library. Guarded
  // on `artistId` inside the hook (no ArtistItems -> disabled), and the current
  // track is excluded so the section only ever lists *other* songs.
  const { items: moreItems } = useArtistSongs(artistId, item?.Id);
  const moreTracks = useMemo(
    () => moreItems.map((it) => audioItemToTrack(it, token)),
    [moreItems, token],
  );
  const albumId = item?.AlbumId ?? null;
  const album = item?.Album ?? null;
  const genres = item?.Genres?.filter(Boolean) ?? [];
  const year = item?.ProductionYear ?? null;
  const duration = trackDuration(item?.RunTimeTicks);

  return (
    <main className="pf-music pf-music--detail">
      <Header />

      {isLoading ? (
        <p className="pf-music__empty">Cargando…</p>
      ) : isError || !item || !track ? (
        <p role="alert" className="pf-music__empty">
          No se pudo cargar la canción.{' '}
          <button type="button" className="pf-music__link-btn" onClick={() => refetch()}>
            Reintentar
          </button>
        </p>
      ) : (
        <>
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
              <span className="pf-music__detail-kicker">Canción</span>
              <h1 className="pf-music__detail-title">{item.Name}</h1>
              {artistNames && <p className="pf-music__detail-artist">{artistNames}</p>}

              <dl className="pf-music__facts">
                {album && (
                  <div className="pf-music__fact">
                    <dt>Álbum</dt>
                    <dd>{album}</dd>
                  </div>
                )}
                {genres.length > 0 && (
                  <div className="pf-music__fact">
                    <dt>Género</dt>
                    <dd>{genres.join(', ')}</dd>
                  </div>
                )}
                {year != null && (
                  <div className="pf-music__fact">
                    <dt>Año</dt>
                    <dd>{year}</dd>
                  </div>
                )}
                {duration && (
                  <div className="pf-music__fact">
                    <dt>Duración</dt>
                    <dd>{duration}</dd>
                  </div>
                )}
              </dl>

              <div className="pf-music__detail-actions">
                <button
                  type="button"
                  className="pf-music__play-album"
                  onClick={() => playNow([track], 0)}
                >
                  Reproducir
                </button>
                <button
                  type="button"
                  className="pf-music__action"
                  onClick={() => enqueue(track)}
                  aria-label={`Agregar ${track.title} a la cola`}
                >
                  + Cola
                </button>
                <AddToPlaylistButton songId={track.itemId} songTitle={track.title} />
                {artistId && (
                  <Link to={`/musica/artist/${artistId}`} className="pf-music__action">
                    Ir al artista
                  </Link>
                )}
                {albumId && (
                  <Link to={`/musica/album/${albumId}`} className="pf-music__action">
                    Ver álbum
                  </Link>
                )}
                <button
                  type="button"
                  className="pf-music__action pf-music__action--danger"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  Borrar de la biblioteca
                </button>
              </div>
            </div>
          </div>

          {moreTracks.length > 0 && (
            <section
              className="pf-music__section"
              aria-label={`Más de ${primaryArtistName ?? 'el artista'}`}
            >
              <h2 className="pf-music__heading">
                Más de {primaryArtistName ?? 'este artista'}
              </h2>
              <ul className="pf-music__list">
                {moreTracks.map((rowTrack, index) => {
                  return (
                    <li key={rowTrack.itemId} className="pf-music__row">
                      <Link
                        to={`/musica/track/${rowTrack.itemId}`}
                        className="pf-music__row-link"
                        aria-label={`Ver ${rowTrack.title}`}
                      >
                        <div className="pf-music__art">
                          <CoverImage src={rowTrack.coverUrl} loading="lazy" />
                        </div>
                        <div className="pf-music__info">
                          <span className="pf-music__title">{rowTrack.title}</span>
                          <span className="pf-music__sub">
                            {rowTrack.artist ?? primaryArtistName ?? 'Desconocido'}
                          </span>
                        </div>
                      </Link>
                      <PlayButton
                        active={current?.itemId === rowTrack.itemId}
                        isPlaying={isPlaying}
                        onClick={() =>
                          current?.itemId === rowTrack.itemId
                            ? toggle()
                            : playNow(moreTracks, index)
                        }
                        label={`Reproducir ${rowTrack.title}`}
                      />
                      <MusicRowMenu
                        title={rowTrack.title}
                        itemId={rowTrack.itemId}
                        onEnqueue={() => enqueue(rowTrack)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
