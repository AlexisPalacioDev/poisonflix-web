import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../../components/Header';
import { useAuth } from '../../hooks/useAuth';
import { useMusicLibrary } from '../../hooks/useMusicLibrary';
import { audioItemToTrack, type AudioTrack } from '../../lib/domain/musicTrack';
import { deleteItem } from '../../api/jellyfin';
import { queryKeys } from '../../hooks/queryKeys';
import { useQueryClient } from '@tanstack/react-query';
import { useMusicPlayer } from './musicPlayerCore';
import { PlayableCover } from './PlayableCover';
import { MusicRowMenu } from './MusicRowMenu';
import './music.css';

// "Tu música descargada" — the songs that actually live on the server.
//
// This used to be the "Canciones" tab, sitting between "Álbumes" and
// "Playlists" inside a browse strip: the owner's own library filed away as if
// it were one more playlist he'd made. It is not a playlist. It is the answer
// to "what do I have?", so it gets a page, a name, a count and a way in from
// the top bar, and it shows everything rather than the first screenful of a
// horizontal rail.
//
// The grid is the Música grid (`pf-music__grid`, the one the Álbumes and
// Artistas tabs already use) rather than `features/browse/BrowseGrid`: that
// component owns its own chrome (its header, its back button, its gold) and
// this section is deliberately green.

/** A downloaded song as a cover card: the same card the recommendation rails
 * use, down to the cover being the play/pause control, so one gesture works
 * everywhere in Música. The title is a link to the track, the ⋮ opens the menu,
 * and neither is nested inside the cover's button. */
function LibraryCard({
  track,
  active,
  isPlaying,
  onPlay,
  onToggle,
  onEnqueue,
  onDelete,
}: {
  track: AudioTrack;
  active: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onToggle: () => void;
  onEnqueue: () => void;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div className="pf-music__rec pf-music__lib-card">
      <PlayableCover
        className="pf-music__rec-art"
        src={track.coverUrl}
        loading="lazy"
        active={active}
        isPlaying={isPlaying}
        glyphSize={22}
        onClick={() => (active ? onToggle() : onPlay())}
        label={`Reproducir ${track.title}`}
        pauseLabel={`Pausar ${track.title}`}
      />
      <div className="pf-music__rec-foot">
        <span className="pf-music__rec-text">
          <Link
            to={`/musica/track/${track.itemId}`}
            className="pf-music__lib-link"
            aria-label={`Ver ${track.title}`}
          >
            {track.title}
          </Link>
          <span className="pf-music__rec-sub">{track.artist ?? 'Desconocido'}</span>
        </span>
        <MusicRowMenu
          title={track.title}
          itemId={track.itemId}
          onEnqueue={onEnqueue}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

export function DownloadedScreen() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const { items, isLoading, isError, refetch } = useMusicLibrary();
  const { playNow, enqueue, current, isPlaying, toggle } = useMusicPlayer();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');

  const tracks = useMemo(
    () => items.map((item) => audioItemToTrack(item, token)),
    [items, token],
  );

  // Filtering happens here, not on the server: the whole library is already in
  // memory, and a round trip per keystroke would make a 40-song library feel
  // slower than scrolling it.
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (needle === '') return tracks;
    return tracks.filter(
      (track) =>
        track.title.toLowerCase().includes(needle) ||
        (track.artist ?? '').toLowerCase().includes(needle),
    );
  }, [tracks, needle]);

  const handleDelete = async (id: string) => {
    await deleteItem(id);
    queryClient.invalidateQueries({
      queryKey: queryKeys.musicLibrary(session?.jellyfinUserId ?? ''),
    });
  };

  // Shuffle a copy: `playNow` keeps the array it is handed as the queue, and
  // reordering the memoised list under the grid would reshuffle the page.
  const handleShuffle = () => {
    const shuffled = [...visible];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (shuffled.length > 0) playNow(shuffled);
  };

  // Counts what is on the page, not what the server says exists. The hook pages
  // until it has the whole library, so the two agree — and if a ceiling ever
  // truncated the walk, this caption would shrink with the grid instead of
  // promising rows that aren't there (and that "Reproducir todo" wouldn't play,
  // and that the filter would answer "Nada coincide" for).
  const countLabel = tracks.length === 1 ? '1 canción' : `${tracks.length} canciones`;

  return (
    <main className="pf-music pf-music__lib">
      <Header />

      <header className="pf-music__lib-hero">
        <p className="pf-music__lib-eyebrow">En tu servidor</p>
        <h1 className="pf-music__lib-title">Tu música descargada</h1>
        <p className="pf-music__lib-count">
          {isLoading ? 'Contando…' : `${countLabel} guardadas, listas para sonar.`}
        </p>

        {tracks.length > 0 && (
          <div className="pf-music__lib-actions">
            <button
              type="button"
              className="pf-music__lib-cta"
              onClick={() => playNow(visible)}
              disabled={visible.length === 0}
            >
              Reproducir todo
            </button>
            <button
              type="button"
              className="pf-music__lib-cta pf-music__lib-cta--ghost"
              onClick={handleShuffle}
              disabled={visible.length === 0}
            >
              Aleatorio
            </button>
          </div>
        )}
      </header>

      {/* Only once there is enough music for finding one song to be a problem.
          A filter box over eight covers is a control asking to be ignored. */}
      {tracks.length > 12 && (
        <div className="pf-music__lib-toolbar">
          <input
            type="search"
            className="pf-music__input pf-music__lib-filter"
            placeholder="Filtrar por título o artista…"
            aria-label="Filtrar tu música descargada"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      <section className="pf-music__section" aria-label="Canciones descargadas">
        {isLoading ? (
          <p className="pf-music__empty">Cargando tu música…</p>
        ) : isError ? (
          <p role="alert" className="pf-music__empty">
            No se pudo leer tu música.{' '}
            <button type="button" className="pf-music__lib-retry" onClick={() => refetch()}>
              Reintentar
            </button>
          </p>
        ) : tracks.length === 0 ? (
          <p className="pf-music__empty">
            Todavía no descargaste música.{' '}
            <Link to="/musica" className="pf-music__lib-inline-link">
              Buscá una canción
            </Link>{' '}
            y descargala: aparece acá.
          </p>
        ) : visible.length === 0 ? (
          <p className="pf-music__empty">Nada coincide con "{filter.trim()}".</p>
        ) : (
          <div className="pf-music__grid">
            {visible.map((track, index) => (
              <LibraryCard
                key={track.itemId}
                track={track}
                active={current?.itemId === track.itemId}
                isPlaying={isPlaying}
                onPlay={() => playNow(visible, index)}
                onToggle={toggle}
                onEnqueue={() => enqueue(track)}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
