import { useMemo, useState } from 'react';
import { Header } from '../../components/Header';
import { useGamesLibrary } from '../../hooks/useGamesLibrary';
import {
  GAME_SYSTEM_ORDER,
  gameSystemLabel,
  type GameSystem,
} from '../../lib/domain/gameSystems';
import { foldForSearch } from '../../lib/domain/searchText';
import type { Game } from '../../api/schemas/games';
import { GameCover } from './GameCover';
import './games.css';

// Juegos: the ROM library as a catalogue, grouped by console.
//
// Box art rather than filenames: a row of "dma priority · 3 KB" is a directory
// listing wearing a card, and nobody recognises a game by its byte count. The
// covers make this shelf the same object as the film library — art first, title
// under it — which is also why the file size is gone from the card face.
//
// Grouped rather than one flat grid because "what can I play" is really "what
// do I have for the SNES" — nobody browses a shelf of cartridges from six
// consoles in title order. The groups follow `GAME_SYSTEM_ORDER`, so the shelf
// is always in the same place even as it fills up.

/** One cartridge. The whole card is the link: a game has no secondary action,
 * so splitting the target would only create ways to miss it on a phone. */
function GameCard({ game }: { game: Game }) {
  return (
    // A real navigation, not a client-side one, and this is load-bearing.
    //
    // EmulatorJS ships no teardown: `emulator.min.js` declares EJS_STORAGE at
    // top level, and its loader re-injects that file unconditionally on every
    // boot — there is no already-loaded check to satisfy. The second injection
    // is a redeclaration, which is a fatal SyntaxError, and the emulator never
    // reaches its canvas. Measured on the deployed build: the FIRST game of a
    // page session works and every one after it is a black rectangle with the
    // right title on it.
    //
    // Purging globals and removing script nodes does not help: removing a
    // <script> does not undo what it already declared. So each game gets a
    // fresh document, which costs about a second and is the only thing that
    // actually works.
    <a href={`/juegos/play/${encodeURIComponent(game.id)}`} className="pf-games__card">
      <span className="pf-games__cover">
        <GameCover id={game.id} title={game.title} />
      </span>
      <span className="pf-games__card-title">{game.title}</span>
    </a>
  );
}

/** Where the ROMs go, spelled out.
 *
 * The library starts empty for everyone, and an empty screen that says nothing
 * is indistinguishable from a broken one. Whoever sees this is the person with
 * SSH on the server, so the answer is the path — not "no hay contenido". */
function EmptyLibrary() {
  return (
    <div className="pf-games__empty-card">
      <h2 className="pf-games__empty-title">Todavía no hay juegos</h2>
      <p className="pf-games__empty-text">
        Copiá las ROMs al servidor, en una carpeta por consola:
      </p>
      <p className="pf-games__path">
        <code>{'${DATA_DIR}/games/<sistema>/'}</code>
      </p>
      <p className="pf-games__empty-text">
        Por ejemplo, <code>{'${DATA_DIR}/games/snes/'}</code> para Super Nintendo. La carpeta se
        lee cada vez que abrís esta pantalla: apenas dejes un archivo ahí, aparece acá.
      </p>
      <p className="pf-games__empty-text">Consolas reconocidas (el nombre de la carpeta):</p>
      <ul className="pf-games__systems">
        {GAME_SYSTEM_ORDER.map((system) => (
          <li key={system} className="pf-games__system-chip">
            <code>{system}</code> <span>{gameSystemLabel(system)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "3 juegos", and "1 juego" without the parenthesised plural. */
function gameCountLabel(count: number): string {
  return count === 1 ? '1 juego' : `${count} juegos`;
}

export function GamesScreen() {
  const { games, isLoading, isError, refetch } = useGamesLibrary();
  const [query, setQuery] = useState('');

  // Filtering in memory, like the downloaded-music screen: the whole listing is
  // already here, and a round trip per keystroke would make a shelf of thirty
  // cartridges feel slower than scrolling it.
  //
  // The haystack is folded once per library rather than once per keystroke, and
  // it carries three things: the title, the console's real name ("Super
  // Nintendo") and the folder name the backend uses ("snes"), because both are
  // things someone actually types when hunting for a game.
  const haystacks = useMemo(
    () =>
      games.map((game) => ({
        game,
        haystack: foldForSearch(`${game.title} ${gameSystemLabel(game.system)} ${game.system}`),
      })),
    [games],
  );

  const needle = foldForSearch(query);
  const searching = needle !== '';
  const visible = useMemo(() => {
    if (!searching) return games;
    return haystacks.filter((entry) => entry.haystack.includes(needle)).map((entry) => entry.game);
  }, [games, haystacks, needle, searching]);

  const groups = useMemo(() => {
    const bySystem = new Map<GameSystem, Game[]>();
    for (const game of visible) {
      const bucket = bySystem.get(game.system);
      if (bucket) bucket.push(game);
      else bySystem.set(game.system, [game]);
    }
    // A console with nothing left after the filter drops out entirely: an
    // empty "Nintendo 64" heading during a search is a promise of games that
    // are not there.
    return GAME_SYSTEM_ORDER.filter((system) => bySystem.has(system)).map((system) => ({
      system,
      games: [...(bySystem.get(system) ?? [])].sort((a, b) => a.title.localeCompare(b.title)),
    }));
  }, [visible]);

  // The one line that reports what the screen is showing. Empty while there is
  // nothing to count, because the card below already explains itself — but the
  // element stays mounted either way: a live region that appears at the same
  // moment its text does is not announced at all.
  const status = isLoading
    ? 'Contando…'
    : games.length === 0
      ? ''
      : searching
        ? // "0 juegos de 12" rather than a second sentence about the miss: the
          // no-results card right below already says it in words, and hearing
          // the same thing twice is what makes a live region annoying enough to
          // be switched off.
          `${gameCountLabel(visible.length)} de ${games.length}.`
        : `${gameCountLabel(games.length)} listos para jugar.`;

  return (
    <main className="pf-games">
      <Header />

      <header className="pf-games__hero">
        <p className="pf-games__eyebrow">En tu servidor</p>
        <h1 className="pf-games__title">Juegos</h1>
        <p className="pf-games__count" role="status">
          {status}
        </p>
      </header>

      {/* Always present once there is a library, not past a card-count
          threshold: a catalogue whose search box appears only after the shelf
          grows is a control nobody learns is there. */}
      {games.length > 0 && (
        <div className="pf-games__toolbar">
          <label className="pf-games__filter-label" htmlFor="pf-games-search">
            Buscar
          </label>
          <input
            id="pf-games-search"
            type="search"
            className="pf-games__filter"
            placeholder="Buscá por juego o consola…"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}

      {/* Shelf first. A background refetch that fails (React Query retries on
          window focus) leaves `isError` true with the library still in memory,
          and hiding rows we are holding would be a lie about what is on the
          server. The error only speaks when there is nothing to show.

          Three different nothings, three different answers: the server did not
          answer, the server answered with an empty shelf, and the shelf is full
          but the search matched none of it. Collapsing any two of them sends
          the owner to check a folder that is fine. */}
      {games.length === 0 ? (
        isLoading ? (
          <p className="pf-games__empty">Cargando tus juegos…</p>
        ) : isError ? (
          <p role="alert" className="pf-games__empty">
            No se pudo leer la biblioteca de juegos.{' '}
            <button type="button" className="pf-games__retry" onClick={() => refetch()}>
              Reintentar
            </button>
          </p>
        ) : (
          <EmptyLibrary />
        )
      ) : groups.length === 0 ? (
        <div className="pf-games__no-results">
          <p className="pf-games__no-results-title">Sin resultados</p>
          <p className="pf-games__empty-text">
            Ningún juego de tu biblioteca coincide con «{query.trim()}». Probá con menos letras o
            con el nombre de la consola.
          </p>
          <button type="button" className="pf-games__retry" onClick={() => setQuery('')}>
            Ver todos los juegos
          </button>
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.system}
            className="pf-games__group"
            aria-label={gameSystemLabel(group.system)}
          >
            <h2 className="pf-games__group-title">{gameSystemLabel(group.system)}</h2>
            <div className="pf-games__grid">
              {group.games.map((game) => (
                <GameCard key={game.id} game={game} />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
