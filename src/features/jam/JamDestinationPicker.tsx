import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
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

  return (
    <label className={`pf-jam-dest${value ? ' pf-jam-dest--on' : ''}`}>
      {/* Lives alongside the picker so it is never unmounted by navigation,
          and so the change event below — a real user gesture — can unlock it
          for iOS, which refuses a play() that no touch asked for. */}
      <audio ref={audioRef} hidden preload="none" />
      <span className="pf-jam-dest__icon" aria-hidden="true">
        {value ? '👥' : '📱'}
      </span>
      <select
        className="pf-jam-dest__select"
        aria-label="Dónde suena la música"
        value={value}
        onChange={(event) => {
          // Synchronously, inside the gesture: this is the only touch the app
          // is guaranteed to get before a room starts playing on its own.
          void unlockAudioElement(audioRef.current);
          setJamDestination(event.target.value || null);
        }}
      >
        <option value="">Sonar en este dispositivo</option>
        {jams.map((entry) => (
          <option key={entry.jam.id} value={entry.jam.id}>
            Sonar en {entry.jam.name}
          </option>
        ))}
      </select>
      {playback.needsGesture && (
        <button
          type="button"
          className="pf-jam-dest__unlock"
          onClick={() => playback.unlock(audioRef.current)}
        >
          Tocá para oír
        </button>
      )}
    </label>
  );
}
