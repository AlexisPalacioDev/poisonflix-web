import { useMemo, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useMusicGenres } from '../../hooks/useMusicGenres';
import { useGenreSongs } from '../../hooks/useGenreSongs';
import { audioItemToTrack } from '../../lib/domain/musicTrack';
import { PlayButton } from './PlayButton';
import { MusicRowMenu } from './MusicRowMenu';
import { useMusicPlayer } from './musicPlayerCore';

// Géneros browse tab: genre chips sourced from Jellyfin's own `MusicGenre`
// tags. Tapping a chip filters the Audio library to that genre and lists the
// songs, each playable straight from the library through the persistent bar.
// Chips and song actions are native <button>s for D-pad navigation.

export function GenresPanel({ active }: { active: boolean }) {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const { items: genres, isLoading, isError } = useMusicGenres(active);
  const { items: songs, isLoading: songsLoading } = useGenreSongs(active ? selected : null);
  const { playNow, enqueue, current, isPlaying, toggle } = useMusicPlayer();

  const tracks = useMemo(
    () => songs.map((item) => audioItemToTrack(item, token)),
    [songs, token],
  );

  return (
    <div role="tabpanel" aria-label="Géneros">
      {isLoading ? (
        <p className="pf-music__empty">Cargando…</p>
      ) : isError ? (
        <p role="alert" className="pf-music__empty">
          No se pudieron cargar los géneros.
        </p>
      ) : genres.length === 0 ? (
        <p className="pf-music__empty">Todavía no hay géneros en tu música.</p>
      ) : (
        <div className="pf-music__chips" role="group" aria-label="Filtrar por género">
          {genres.map((genre) => {
            const isSelected = selected === genre.Name;
            return (
              <button
                key={genre.Id}
                type="button"
                className={`pf-music__chip${isSelected ? ' pf-music__chip--active' : ''}`}
                onClick={() => setSelected(isSelected ? null : genre.Name)}
                aria-pressed={isSelected}
              >
                {genre.Name}
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="pf-music__genre-songs">
          <h3 className="pf-music__heading pf-music__heading--sub">{selected}</h3>
          {songsLoading ? (
            <p className="pf-music__empty">Cargando…</p>
          ) : tracks.length === 0 ? (
            <p className="pf-music__empty">No hay canciones de {selected} en tu música.</p>
          ) : (
            <ul className="pf-music__list">
              {tracks.map((track, index) => {
                const isCurrent = current?.itemId === track.itemId;
                return (
                  <li
                    key={track.itemId}
                    className={`pf-music__row${isCurrent ? ' pf-music__row--active' : ''}`}
                  >
                    <div className="pf-music__art">
                      {track.coverUrl ? (
                        <img src={track.coverUrl} alt="" loading="lazy" />
                      ) : (
                        <span aria-hidden="true">♪</span>
                      )}
                    </div>
                    <div className="pf-music__info">
                      <span className="pf-music__title">{track.title}</span>
                      <span className="pf-music__sub">{track.artist ?? 'Desconocido'}</span>
                    </div>
                    <PlayButton
                      active={isCurrent}
                      isPlaying={isPlaying}
                      onClick={() => (isCurrent ? toggle() : playNow(tracks, index))}
                      label={`Reproducir ${track.title}`}
                    />
                    <MusicRowMenu
                      title={track.title}
                      itemId={track.itemId}
                      onEnqueue={() => enqueue(track)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
