import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Header } from '../../components/Header';
import { useAuth } from '../../hooks/useAuth';
import { useAlbumTracks } from '../../hooks/useAlbumTracks';
import { deleteItem } from '../../api/jellyfin';
import { resolveCoverUrl } from '../../lib/domain/posterUrl';
import { audioItemToTrack } from '../../lib/domain/musicTrack';
import { CoverImage } from './CoverImage';
import { PlayButton } from './PlayButton';
import { MusicRowMenu } from './MusicRowMenu';
import { useMusicPlayer } from './musicPlayerCore';
import './music.css';

// Album detail (Slice 3): route /musica/album/:id. Header (cover, album name,
// artist) built from the album's own tracks, then a numbered track list. The
// whole album plays with "Reproducir álbum" (playNow from track 0); each row
// can play from that point or push the single track onto the queue.

function trackDuration(ticks: number | null | undefined): string {
  if (!ticks || ticks <= 0) return '';
  const seconds = Math.floor(ticks / 10_000_000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function AlbumScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const { items, isLoading, isError, refetch } = useAlbumTracks(id);
  const { playNow, enqueue, current, isPlaying, toggle } = useMusicPlayer();

  const tracks = useMemo(() => items.map((item) => audioItemToTrack(item, token)), [items, token]);

  const first = items[0];
  const albumName = first?.Album ?? first?.Name ?? 'Álbum';
  const albumArtist = first?.AlbumArtist ?? first?.Artists?.[0] ?? null;
  const cover = first ? resolveCoverUrl(first, token, 600) : null;

  // Deletes are confirmed inside the row menu; here we just remove + refresh.
  const handleDelete = async (itemId: string) => {
    await deleteItem(itemId);
    await refetch();
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
          <span className="pf-music__detail-kicker">Álbum</span>
          <h1 className="pf-music__detail-title">{albumName}</h1>
          {albumArtist && <p className="pf-music__detail-artist">{albumArtist}</p>}
          <button
            type="button"
            className="pf-music__play-album"
            onClick={() => playNow(tracks, 0)}
            disabled={tracks.length === 0}
          >
            Reproducir álbum
          </button>
        </div>
      </div>

      <section className="pf-music__section" aria-label="Pistas del álbum">
        {isLoading ? (
          <p className="pf-music__empty">Cargando…</p>
        ) : isError ? (
          <p role="alert" className="pf-music__empty">
            No se pudo cargar el álbum.{' '}
            <button type="button" className="pf-music__link-btn" onClick={() => refetch()}>
              Reintentar
            </button>
          </p>
        ) : tracks.length === 0 ? (
          <p className="pf-music__empty">Este álbum no tiene pistas.</p>
        ) : (
          <ul className="pf-music__list">
            {items.map((item, index) => {
              const track = tracks[index];
              return (
                <li key={track.itemId} className="pf-music__row">
                  <span className="pf-music__track-no">{item.IndexNumber ?? index + 1}</span>
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
                    onDelete={handleDelete}
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
