import { Link, useNavigate, useParams } from 'react-router-dom';
import { Header } from '../../components/Header';
import { useAuth } from '../../hooks/useAuth';
import { useArtistAlbums } from '../../hooks/useArtistAlbums';
import { resolveCoverUrl } from '../../lib/domain/posterUrl';
import { CoverImage } from './CoverImage';
import './music.css';

// Artist detail (Slice 3): route /musica/artist/:id. The artist's albums as a
// grid of covers, each opening its album page. The artist name is derived from
// the first album's album-artist credit (albums are the only thing we fetch —
// no unbounded track pull just to render a header).

export function ArtistScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const { items: albums, isLoading, isError, refetch } = useArtistAlbums(id);

  const artistName = albums[0]?.AlbumArtist ?? albums[0]?.Artists?.[0] ?? 'Artista';

  return (
    <main className="pf-music pf-music--detail">
      <Header />

      <div className="pf-music__detail-head pf-music__detail-head--artist">
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
        <div className="pf-music__detail-meta">
          <span className="pf-music__detail-kicker">Artista</span>
          <h1 className="pf-music__detail-title">{artistName}</h1>
        </div>
      </div>

      <section className="pf-music__section" aria-label="Álbumes del artista">
        <h2 className="pf-music__heading">Álbumes</h2>
        {isLoading ? (
          <p className="pf-music__empty">Cargando…</p>
        ) : isError ? (
          <p role="alert" className="pf-music__empty">
            No se pudieron cargar los álbumes.{' '}
            <button type="button" className="pf-music__link-btn" onClick={() => refetch()}>
              Reintentar
            </button>
          </p>
        ) : albums.length === 0 ? (
          <p className="pf-music__empty">Este artista no tiene álbumes.</p>
        ) : (
          <div className="pf-music__grid">
            {albums.map((album) => {
              const cover = resolveCoverUrl(album, token);
              return (
              <Link key={album.Id} to={`/musica/album/${album.Id}`} className="pf-music__card">
                <div className="pf-music__card-art">
                  <CoverImage src={cover} loading="lazy" />
                </div>
                <span className="pf-music__card-title">{album.Name}</span>
                {album.ProductionYear && (
                  <span className="pf-music__card-sub">{album.ProductionYear}</span>
                )}
              </Link>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
