import { useQuery } from '@tanstack/react-query';
import { listJams } from '../../api/jam';
import { queryKeys } from '../../hooks/queryKeys';
import { useAuth } from '../../hooks/useAuth';
import { setJamDestination, useJamDestination } from './destination';
import { useJamStream } from './useJamStream';
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
  useJamStream(destination);

  const jamsQuery = useQuery({
    queryKey: queryKeys.jamList(),
    queryFn: listJams,
    enabled: Boolean(session),
  });

  // Only rooms actually joined can receive playback; a pending invitation is
  // not somewhere to send your music.
  const jams = (jamsQuery.data ?? []).filter((entry) => entry.myRole?.acceptedAt != null);

  if (!session || jams.length === 0) return null;

  // A destination that no longer exists (left the room, it was deleted) must
  // not keep swallowing playback silently.
  const known = jams.some((entry) => entry.jam.id === destination);
  const value = known ? (destination ?? '') : '';
  if (destination && !known) setJamDestination(null);

  return (
    <label className={`pf-jam-dest${value ? ' pf-jam-dest--on' : ''}`}>
      <span className="pf-jam-dest__icon" aria-hidden="true">
        {value ? '👥' : '📱'}
      </span>
      <select
        className="pf-jam-dest__select"
        aria-label="Dónde suena la música"
        value={value}
        onChange={(event) => setJamDestination(event.target.value || null)}
      >
        <option value="">Sonar en este dispositivo</option>
        {jams.map((entry) => (
          <option key={entry.jam.id} value={entry.jam.id}>
            Sonar en {entry.jam.name}
          </option>
        ))}
      </select>
    </label>
  );
}
