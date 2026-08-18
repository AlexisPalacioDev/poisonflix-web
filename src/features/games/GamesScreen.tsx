import { useMemo, useState } from 'react';
import { Header } from '../../components/Header';
import { useGamesLibrary } from '../../hooks/useGamesLibrary';
import {
  GAME_SYSTEM_ORDER,
  gameSystemLabel,
  type GameSystem,
} from '../../lib/domain/gameSystems';
import type { Game } from '../../api/schemas/games';
import './games.css';

// Juegos: the ROM library, grouped by console.
//
// Grouped rather than one flat grid because "what can I play" is really "what
// do I have for the SNES" — nobody browses a shelf of cartridges from six
// consoles in title order. The groups follow `GAME_SYSTEM_ORDER`, so the shelf
// is always in the same place even as it fills up.

/** Human-sized file size. ROMs run from 32 KB (a NES cartridge) to a few
 * hundred MB (a CD image), so the unit has to move with them. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One cartridge. The whole card is the link: a game has no secondary action,
 * so splitting the target would only create ways to miss it on a phone. */
function GameCard({ game }: { game: Game }) {
  const size = formatSize(game.sizeBytes);
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
      <span className="pf-games__card-art" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="30" height="30" focusable="false">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 8h10a4 4 0 0 1 3.9 3.1l1 4.4A2.6 2.6 0 0 1 16.8 17L15 15H9l-1.8 2a2.6 2.6 0 0 1-5.1-1.5l1-4.4A4 4 0 0 1 7 8Z"
          />
          <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M7 11v3M5.5 12.5h3" />
          <circle cx="16" cy="12" r="1.1" fill="currentColor" />
          <circle cx="18" cy="14" r="1.1" fill="currentColor" />
        </svg>
      </span>
      <span className="pf-games__card-text">
        <span className="pf-games__card-title">{game.title}</span>
        {size && <span className="pf-games__card-sub">{size}</span>}
      </span>
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

export function GamesScreen() {
  const { games, isLoading, isError, refetch } = useGamesLibrary();
  const [filter, setFilter] = useState('');

  // Filtering in memory, like the downloaded-music screen: the whole listing is
  // already here, and a round trip per keystroke would make a shelf of thirty
  // cartridges feel slower than scrolling it.
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (needle === '') return games;
    return games.filter((game) => game.title.toLowerCase().includes(needle));
  }, [games, needle]);

  const groups = useMemo(() => {
    const bySystem = new Map<GameSystem, Game[]>();
    for (const game of visible) {
      const bucket = bySystem.get(game.system);
      if (bucket) bucket.push(game);
      else bySystem.set(game.system, [game]);
    }
    return GAME_SYSTEM_ORDER.filter((system) => bySystem.has(system)).map((system) => ({
      system,
      games: [...(bySystem.get(system) ?? [])].sort((a, b) => a.title.localeCompare(b.title)),
    }));
  }, [visible]);

  const countLabel = games.length === 1 ? '1 juego' : `${games.length} juegos`;

  return (
    <main className="pf-games">
      <Header />

      <header className="pf-games__hero">
        <p className="pf-games__eyebrow">En tu servidor</p>
        <h1 className="pf-games__title">Juegos</h1>
        <p className="pf-games__count">
          {isLoading ? 'Contando…' : `${countLabel} listos para jugar.`}
        </p>
      </header>

      {/* Same rule as the music library: a filter box over eight cards is a
          control asking to be ignored. */}
      {games.length > 12 && (
        <div className="pf-games__toolbar">
          <input
            type="search"
            className="pf-games__filter"
            placeholder="Buscar un juego…"
            aria-label="Buscar un juego"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      {/* Shelf first. A background refetch that fails (React Query retries on
          window focus) leaves `isError` true with the library still in memory,
          and hiding rows we are holding would be a lie about what is on the
          server. The error only speaks when there is nothing to show. */}
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
        <p className="pf-games__empty">Nada coincide con "{filter.trim()}".</p>
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
