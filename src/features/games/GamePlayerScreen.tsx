import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { romUrl } from '../../api/games';
import { useGamesLibrary } from '../../hooks/useGamesLibrary';
import { gameSystemLabel } from '../../lib/domain/gameSystems';
import { startEmulator, stopEmulator } from './emulatorjs';
import './games.css';

// The emulator, full bleed.
//
// No `<Header />`: this screen is a console, and a fixed top bar over a running
// game steals both the pixels and the taps. The only chrome is a way out.
//
// The URL carries just the id, so the console the ROM belongs to is looked up
// in the library rather than passed through router state — state a reload or a
// shared link would not have.

/** The element EmulatorJS takes over. It replaces the node's contents wholesale,
 * so nothing of ours may live inside it. */
const PLAYER_ID = 'game';

export function GamePlayerScreen() {
  const { id = '' } = useParams<{ id: string }>();
  const { games, isLoading, isError } = useGamesLibrary();

  const game = games.find((candidate) => candidate.id === id);
  // Depended on as primitives, not as the object: the query hands back a fresh
  // array on every refetch, and re-running this effect means rebooting the game
  // under the player's hands.
  const core = game?.system;
  const title = game?.title;

  // The runtime is fetched at deploy time, not bundled, so "the emulator itself
  // did not load" is a state this screen has to be able to say out loud. Silence
  // there is a black rectangle and no way to tell it from a game that is simply
  // slow.
  const [loaderFailed, setLoaderFailed] = useState(false);

  useEffect(() => {
    if (!core) return undefined;
    setLoaderFailed(false);
    const token = startEmulator({
      playerSelector: `#${PLAYER_ID}`,
      core,
      gameUrl: romUrl(id),
      gameName: title ?? 'Juego',
      onLoadError: () => setLoaderFailed(true),
    });
    // Leaving this screen must leave nothing behind — see `emulatorjs.ts`. A
    // surviving global is how you tap one game and boot the previous one.
    // Scoped to THIS boot: leaving one game and opening another fires this
    // cleanup after the next emulator has already started.
    return () => stopEmulator(token);
  }, [id, core, title]);

  return (
    <main className="pf-games pf-games__player">
      <div className="pf-games__player-bar">
        <Link to="/juegos" className="pf-games__back" aria-label="Volver a Juegos">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 5l-7 7 7 7"
            />
          </svg>
          <span>Volver</span>
        </Link>
        <span className="pf-games__player-title">{title ?? 'Juego'}</span>
        {game && <span className="pf-games__player-system">{gameSystemLabel(game.system)}</span>}
      </div>

      {/* The game we have wins over every other state, and that order is the
          whole point: React Query refetches on window focus, and a background
          refetch that fails leaves `isError` true with the cached library
          intact. Checking `isError` first would unmount the canvas out from
          under someone mid-level - and because `id`/`core`/`title` never
          changed, the effect would not re-run, so the emulator would keep
          running inside a node nobody can see. */}
      {game ? (
        <>
          {/* EmulatorJS owns everything inside: its canvas, its start screen
              (the tap that unlocks audio on a phone), its on-screen gamepad,
              and a paired Bluetooth controller through the Gamepad API. */}
          <div id={PLAYER_ID} className="pf-games__canvas" data-testid="game-canvas" />
          {loaderFailed && (
            <p role="alert" className="pf-games__empty">
              No se pudo cargar el emulador. Falta el runtime en el servidor.
            </p>
          )}
        </>
      ) : isLoading ? (
        <p className="pf-games__empty">Cargando el juego…</p>
      ) : isError ? (
        <p role="alert" className="pf-games__empty">
          No se pudo leer la biblioteca de juegos.
        </p>
      ) : (
        <p role="alert" className="pf-games__empty">
          Ese juego ya no está en el servidor.{' '}
          <Link to="/juegos" className="pf-games__inline-link">
            Volver a Juegos
          </Link>
        </p>
      )}
    </main>
  );
}
