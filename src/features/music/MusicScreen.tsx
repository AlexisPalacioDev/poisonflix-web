import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../../components/Header';
import { useAuth } from '../../hooks/useAuth';
import { useMusicSearch } from '../../hooks/useMusicSearch';
import { useMusicLibrary } from '../../hooks/useMusicLibrary';
import { useMusicAlbums } from '../../hooks/useMusicAlbums';
import { useMusicArtists } from '../../hooks/useMusicArtists';
import { useMusicDownload } from '../../hooks/useMusicDownload';
import { usePersonalMusicFeed } from '../../hooks/usePersonalMusicFeed';
import { resolveCoverUrl } from '../../lib/domain/posterUrl';
import { audioItemToTrack, searchResultToTrack } from '../../lib/domain/musicTrack';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicSearchResult, MusicSongResult, MusicSource } from '../../api/schemas/music';
import { useMusicPlayer } from './musicPlayerCore';
import { SourceToggle } from './SourceToggle';
import { CoverImage } from './CoverImage';
import { MusicResultRow } from './MusicResultRow';
import { MusicCollectionCard } from './MusicCollectionCard';
import { RecommendationsRow } from './RecommendationsRow';
import { GenresPanel } from './GenresPanel';
import { PlaylistsPanel } from './PlaylistsPanel';
import { PlayButton } from './PlayButton';
import { MusicRowMenu } from './MusicRowMenu';
import { MyMusicStats } from './MyMusicStats';
import { deleteItem } from '../../api/jellyfin';
import { getRecommendations } from '../../api/music';
import { RADIO_SIZE } from './useAutoplayRadio';
import { queryKeys } from '../../hooks/queryKeys';
import { useQueryClient } from '@tanstack/react-query';
import './music.css';

// Música home (Spotify-style landing): a search field with a source toggle
// (Auto / YT Music / YouTube), a "Recomendados para ti" rail, and the browse
// tabs — Canciones, Álbumes, Artistas and Géneros. Search results take over the
// landing while a query is active. Search / recommendation feeds are a typed
// union: songs play on click, while album/playlist hits render as collection
// cards that download the whole batch on their "Descargar" button.

type BrowseTab = 'canciones' | 'albumes' | 'artistas' | 'generos' | 'playlists';

const TABS: { id: BrowseTab; label: string }[] = [
  { id: 'canciones', label: 'Canciones' },
  { id: 'albumes', label: 'Álbumes' },
  { id: 'artistas', label: 'Artistas' },
  { id: 'generos', label: 'Géneros' },
  { id: 'playlists', label: 'Playlists' },
];

// A card in the Álbumes/Artistas grids: cover + name + optional subtitle,
// linking to the item's detail page. Reused for both item types.
function MediaCard({
  to,
  cover,
  title,
  subtitle,
  round,
}: {
  to: string;
  cover: string | null;
  title: string;
  subtitle?: string | null;
  round?: boolean;
}) {
  return (
    <Link to={to} className="pf-music__card">
      <div className={`pf-music__card-art${round ? ' pf-music__card-art--round' : ''}`}>
        <CoverImage src={cover} loading="lazy" />
      </div>
      <span className="pf-music__card-title">{title}</span>
      {subtitle && <span className="pf-music__card-sub">{subtitle}</span>}
    </Link>
  );
}

export function MusicScreen() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<MusicSource>('auto');
  const [tab, setTab] = useState<BrowseTab>('canciones');

  const { debouncedQuery, enabled, isLoading, isError, results } = useMusicSearch(query, source);
  const { download, stateByVideoId, itemByVideoId } = useMusicDownload();
  const { rows: feedRows, isLoading: feedLoading } = usePersonalMusicFeed();
  const { items: libraryItems, isLoading: libraryLoading } = useMusicLibrary();
  const { items: albums, isLoading: albumsLoading, isError: albumsError } = useMusicAlbums(
    tab === 'albumes',
  );
  const { items: artists, isLoading: artistsLoading, isError: artistsError } = useMusicArtists(
    tab === 'artistas',
  );
  const { playNow, enqueue, current, isPlaying, toggle, autoplay } = useMusicPlayer();
  const queryClient = useQueryClient();
  const handleDeleteLibrary = async (id: string) => {
    await deleteItem(id);
    queryClient.invalidateQueries({ queryKey: queryKeys.musicLibrary(session?.jellyfinUserId ?? '') });
  };

  const libraryTracks = useMemo(
    () => libraryItems.map((item) => audioItemToTrack(item, token)),
    [libraryItems, token],
  );

  const handleDownload = (result: MusicSearchResult) => {
    download({
      videoId: result.videoId,
      title: result.title ?? undefined,
      artist: result.artist ?? undefined,
      album: result.album ?? undefined,
    });
  };

  // A completed download resolves to a Jellyfin Audio item — build a track from
  // the search result's metadata so it can be played/enqueued straight away.
  const resultToTrack = (result: MusicSearchResult, itemId: string) => ({
    itemId,
    title: result.title ?? 'Sin título',
    artist: result.artist ?? null,
    coverUrl: result.thumbnailUrl ?? null,
  });

  // Radio, the YouTube Music model: playing a search hit doesn't only play that
  // hit — it fills the queue with related tracks *up front*, the way YT Music
  // turns any song you tap into a station. The worker's /recommendations?seed=
  // is ytmusicapi's get_watch_playlist, i.e. that very station. `useAutoplayRadio`
  // then keeps extending it from any surface once it runs out; this immediate
  // seed is what makes tapping a search result feel like YT Music rather than
  // like a one-track queue that only continues after it ends.
  const radioRunRef = useRef(0);

  const startRadio = async (seedVideoId: string) => {
    if (!autoplay) return;
    const run = ++radioRunRef.current;
    try {
      const related = await getRecommendations(seedVideoId, RADIO_SIZE);
      // A newer play happened while this was in flight: dropping the stale radio
      // keeps it from landing behind whatever the user is listening to now.
      if (run !== radioRunRef.current) return;
      const tracks = related
        .filter((item): item is MusicSongResult => item.type === 'song')
        .filter((song) => song.videoId !== seedVideoId)
        .map(searchResultToTrack);
      if (tracks.length > 0) enqueue(tracks);
    } catch {
      // Recommendations are best-effort on the worker too — stay quiet.
    }
  };

  const handlePlayResult = (result: MusicSearchResult, itemId: string) => {
    playNow([resultToTrack(result, itemId)]);
    void startRadio(result.videoId);
  };
  const handleEnqueueResult = (result: MusicSearchResult, itemId: string) =>
    enqueue(resultToTrack(result, itemId));

  // Instant-play a result that isn't downloaded yet: `searchResultToTrack` gives
  // it a "preview" src — the worker's /bff/music/stream proxy for its videoId —
  // so it plays right away without waiting on a download.
  const handlePreview = (result: MusicSearchResult) => {
    playNow([searchResultToTrack(result)]);
    void startRadio(result.videoId);
  };

  const albumSubtitle = (item: JellyfinItem): string | null =>
    item.AlbumArtist ?? item.Artists?.[0] ?? null;

  // Typing anything switches the landing into the search view (Spotify-style);
  // the empty state inside it still nudges toward the 2-char minimum until the
  // query actually fires.
  const searching = query.trim().length > 0;

  const searchEmpty = enabled
    ? `Sin resultados para "${debouncedQuery}"`
    : 'Escribí al menos 2 caracteres para buscar música.';

  return (
    <main className="pf-music">
      <Header />

      <div className="pf-music__hero">
        <div className="pf-music__query">
          <span className="pf-music__query-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
              <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
              <line
                x1="15"
                y1="15"
                x2="21"
                y2="21"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <input
            type="search"
            className="pf-music__input pf-music__input--search"
            placeholder="Buscar en YouTube Music…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Buscar música"
            autoFocus
          />
        </div>
        <SourceToggle value={source} onChange={setSource} />
      </div>

      {searching ? (
        <section className="pf-music__section" aria-label="Resultados de búsqueda">
          <h2 className="pf-music__heading">Resultados</h2>
          {isError ? (
            <p role="alert" className="pf-music__empty">
              No se pudo buscar. Probá de nuevo.
            </p>
          ) : isLoading ? (
            <p className="pf-music__empty">Buscando…</p>
          ) : results.length === 0 ? (
            <p className="pf-music__empty">{searchEmpty}</p>
          ) : (
            <ul className="pf-music__list">
              {results.map((result) =>
                result.type === 'song' ? (
                  <MusicResultRow
                    key={`song-${result.videoId}`}
                    result={result}
                    state={stateByVideoId(result.videoId)}
                    itemId={itemByVideoId(result.videoId)}
                    onDownload={handleDownload}
                    onPlay={handlePlayResult}
                    onEnqueue={handleEnqueueResult}
                    onPreview={handlePreview}
                  />
                ) : (
                  <MusicCollectionCard
                    key={
                      result.type === 'album'
                        ? `album-${result.browseId}`
                        : `playlist-${result.playlistId}`
                    }
                    item={result}
                  />
                ),
              )}
            </ul>
          )}
        </section>
      ) : (
        <>
          {/* One rail per reason: the mix first, then a row per artist the
              history says they're into. While the first load is in flight the
              generic-looking single rail keeps the layout from jumping. */}
          {feedRows.length === 0 ? (
            <RecommendationsRow
              items={[]}
              isLoading={feedLoading}
              onPlay={handlePlayResult}
              onPreview={handlePreview}
            />
          ) : (
            feedRows.map((row) => (
              <RecommendationsRow
                key={row.key}
                title={row.title}
                items={row.items}
                isLoading={false}
                onPlay={handlePlayResult}
                onPreview={handlePreview}
              />
            ))
          )}
        </>
      )}

      {!searching && <MyMusicStats />}

      <section className="pf-music__section" aria-label="Tu música">
        <div className="pf-music__tabs" role="tablist" aria-label="Explorar tu música">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`pf-music__tab${tab === id ? ' pf-music__tab--active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'canciones' && (
          <div role="tabpanel" aria-label="Canciones">
            {libraryLoading ? (
              <p className="pf-music__empty">Cargando…</p>
            ) : libraryTracks.length === 0 ? (
              <p className="pf-music__empty">Todavía no descargaste música.</p>
            ) : (
              <ul className="pf-music__list">
                {libraryTracks.map((track, index) => {
                  const active = current?.itemId === track.itemId;
                  return (
                    <li
                      key={track.itemId}
                      className={`pf-music__row${active ? ' pf-music__row--active' : ''}`}
                    >
                      <Link
                        to={`/musica/track/${track.itemId}`}
                        className="pf-music__row-link"
                        aria-label={`Ver ${track.title}`}
                      >
                        <div className="pf-music__art">
                          <CoverImage src={track.coverUrl} />
                        </div>
                        <div className="pf-music__info">
                          <span className="pf-music__title">{track.title}</span>
                          <span className="pf-music__sub">{track.artist ?? 'Desconocido'}</span>
                        </div>
                      </Link>
                      <PlayButton
                        active={active}
                        isPlaying={isPlaying}
                        onClick={() => (active ? toggle() : playNow(libraryTracks, index))}
                        label={`Reproducir ${track.title}`}
                      />
                      <MusicRowMenu
                        title={track.title}
                        itemId={track.itemId}
                        onEnqueue={() => enqueue(track)}
                        onDelete={handleDeleteLibrary}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {tab === 'albumes' && (
          <div role="tabpanel" aria-label="Álbumes">
            {albumsLoading ? (
              <p className="pf-music__empty">Cargando…</p>
            ) : albumsError ? (
              <p role="alert" className="pf-music__empty">
                No se pudieron cargar los álbumes.
              </p>
            ) : albums.length === 0 ? (
              <p className="pf-music__empty">Todavía no hay álbumes.</p>
            ) : (
              <div className="pf-music__grid">
                {albums.map((album) => (
                  <MediaCard
                    key={album.Id}
                    to={`/musica/album/${album.Id}`}
                    cover={resolveCoverUrl(album, token)}
                    title={album.Name}
                    subtitle={albumSubtitle(album)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'artistas' && (
          <div role="tabpanel" aria-label="Artistas">
            {artistsLoading ? (
              <p className="pf-music__empty">Cargando…</p>
            ) : artistsError ? (
              <p role="alert" className="pf-music__empty">
                No se pudieron cargar los artistas.
              </p>
            ) : artists.length === 0 ? (
              <p className="pf-music__empty">Todavía no hay artistas.</p>
            ) : (
              <div className="pf-music__grid pf-music__grid--artists">
                {artists.map((artist) => (
                  <MediaCard
                    key={artist.Id}
                    to={`/musica/artist/${artist.Id}`}
                    cover={resolveCoverUrl(artist, token)}
                    title={artist.Name}
                    round
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'generos' && <GenresPanel active={tab === 'generos'} />}

        {tab === 'playlists' && <PlaylistsPanel active={tab === 'playlists'} />}
      </section>
    </main>
  );
}
