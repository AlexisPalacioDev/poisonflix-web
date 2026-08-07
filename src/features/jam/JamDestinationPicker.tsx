import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { listJams } from '../../api/jam';
import { queryKeys } from '../../hooks/queryKeys';
import { useAuth } from '../../hooks/useAuth';
import { setJamDestination, useJamDestination } from './destination';
import { useJamStream } from './useJamStream';
import { useJamPlayback, unlockAudioElement } from './useJamPlayback';
import './jam.css';

// Where playback goes: this device, or one of your Jams.
//
// The whole feature turns on this control. Before it, a Jam was a room you had
// to carry songs into one at a time through a menu the owner could not find —
// and once found, it was in the wrong place anyway. As an output, the room
// fills itself: pick it here, then play anything, anywhere in the app.
//
// Rendered only when there is a choice to make. Someone with no Jams has one
// possible output, and a select with a single option is furniture.

export function JamDestinationPicker() {
  const { session } = useAuth();
  const destination = useJamDestination();

  // Choosing to play into a room IS attending it. Presence in this app is the
  // open SSE connection, and transport rights require presence — so without
  // this, selecting a Jam as your output let you APPEND to its queue but not
  // replace it, and pressing play silently half-worked. Holding the stream
  // here also means the room sees you arrive the moment you point your music
  // at it, which is what anyone else in it would expect.
  const { snapshot } = useJamStream(destination);

  // The follower lives HERE, with the destination, not inside the Jam screen.
  // While it lived in the room, a device that had chosen a Jam as its output
  // sent music there and then sat silent unless you happened to be looking at
  // the room — everyone else heard it, you did not. The output is a property
  // of the app, so what follows the output has to be too.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const jamsQuery = useQuery({
    queryKey: queryKeys.jamList(),
    queryFn: listJams,
    enabled: Boolean(session),
  });

  // Only rooms actually joined can receive playback; a pending invitation is
  // not somewhere to send your music.
  const jams = (jamsQuery.data ?? []).filter((entry) => entry.myRole?.acceptedAt != null);

  // Own id comes from the caller's own membership row; the session store only
  // carries the Jellyfin GUID, which is a different identity space.
  const ownUserId = useMemo(
    () => jamsQuery.data?.find((entry) => entry.myRole)?.myRole?.userId ?? null,
    [jamsQuery.data],
  );
  const playback = useJamPlayback(snapshot, ownUserId, audioRef);

  if (!session || jams.length === 0) return null;

  // A destination that no longer exists (left the room, it was deleted) must
  // not keep swallowing playback silently.
  const known = jams.some((entry) => entry.jam.id === destination);
  const value = known ? (destination ?? '') : '';
  if (destination && !known) setJamDestination(null);

  const activeName = jams.find((entry) => entry.jam.id === value)?.jam.name ?? 'Este dispositivo';

  const choose = (jamId: string | null) => {
    // Synchronously, inside the tap: the only gesture the app is guaranteed to
    // get before a room starts playing on its own, and iOS refuses a play()
    // that no touch asked for.
    void unlockAudioElement(audioRef.current);
    setJamDestination(jamId);
    setOpen(false);
  };

  return (
    <div className={`pf-jam-dest${value ? ' pf-jam-dest--on' : ''}`}>
      {/* Lives alongside the picker so navigation never unmounts it. */}
      <audio ref={audioRef} hidden preload="none" />

      {/* A native <select> was the obvious choice and the wrong one: the OS
          paints its list with its own colours — white on a dark app — and
          positions it itself, so on a phone it spilled past the edge of the
          screen and got clipped. This is the same OverlayShell the header
          menu uses, which stays inside the viewport and looks like the app. */}
      <button
        ref={pillRef}
        type="button"
        className="pf-jam-dest__pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Dónde suena la música: ${activeName}`}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="pf-jam-dest__icon" aria-hidden="true">{value ? '👥' : '📱'}</span>
        <span className="pf-jam-dest__name">{activeName}</span>
      </button>

      {playback.needsGesture && (
        <button
          type="button"
          className="pf-jam-dest__unlock"
          aria-label="Tocá para oír en este dispositivo"
          title="Tocá para oír en este dispositivo"
          onClick={() => playback.unlock(audioRef.current)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        </button>
      )}

      {open && (
        <OverlayShell
          variant="menu"
          onDismiss={() => setOpen(false)}
          ariaLabel="Cerrar selector de salida (fondo)"
          anchorRef={pillRef}
        >
          <ul className="pf-jam-dest__list" role="listbox" aria-label="Dónde suena la música">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value}
                className={`pf-jam-dest__opt${!value ? ' pf-jam-dest__opt--on' : ''}`}
                onClick={() => choose(null)}
              >
                📱 Este dispositivo
              </button>
            </li>
            {jams.map((entry) => (
              <li key={entry.jam.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === entry.jam.id}
                  className={`pf-jam-dest__opt${value === entry.jam.id ? ' pf-jam-dest__opt--on' : ''}`}
                  onClick={() => choose(entry.jam.id)}
                >
                  👥 {entry.jam.name}
                </button>
              </li>
            ))}
          </ul>
        </OverlayShell>
      )}
    </div>
  );
}
