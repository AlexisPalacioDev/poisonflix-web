import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listJams } from '../../api/jam';
import { queryKeys } from '../../hooks/queryKeys';
import { useAuth } from '../../hooks/useAuth';
import { setJamDestination, useJamDestination } from './destination';
import { useJamStream } from './useJamStream';
import { useJamPlayback, unlockAudioElement } from './useJamPlayback';
import './jam.css';

// The engine behind "play into a Jam", with no interface of its own.
//
// There used to be a dropdown here. It was redundant: the Jam rail on /musica
// already shows every room as a card, and tapping a card is the obvious way to
// choose one — a second control in the header did the same job with less
// information and more chrome.
//
// What could not move into the rail is everything invisible: the audio element
// (which must never unmount, or playback stops mid-song), the follower that
// keeps this device in step with the room, and the SSE connection that both
// holds presence and earns the transport rights replacing a queue requires.
// Those live here, app-wide, and the cards just set the destination.

export function JamPlaybackHost() {
  const { session } = useAuth();
  const destination = useJamDestination();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Choosing to play into a room IS attending it: presence is this connection,
  // and replacing what a room is hearing takes transport rights, which take
  // presence.
  const { snapshot } = useJamStream(destination);

  const jamsQuery = useQuery({
    queryKey: queryKeys.jamList(),
    queryFn: listJams,
    enabled: Boolean(session),
  });

  const ownUserId = useMemo(
    () => jamsQuery.data?.find((entry) => entry.myRole)?.myRole?.userId ?? null,
    [jamsQuery.data],
  );
  const playback = useJamPlayback(snapshot, ownUserId, audioRef);

  // A destination whose room is gone must not keep swallowing playback.
  const stillMine = (jamsQuery.data ?? []).some(
    (entry) => entry.jam.id === destination && entry.myRole?.acceptedAt != null,
  );
  if (destination && jamsQuery.isSuccess && !stillMine) setJamDestination(null);

  if (!session) return null;

  return (
    <>
      <audio ref={audioRef} hidden preload="none" />
      {/* Rare: only when the browser refused to start audio without a touch.
          The tap that selected the Jam usually supplies it. */}
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
    </>
  );
}

/** Called from the Jam cards: selecting a room is also the user gesture that
 *  unlocks audio on iOS, so it has to run inside that tap. */
export function chooseJamDestination(jamId: string | null, audio?: HTMLAudioElement | null): void {
  if (audio) void unlockAudioElement(audio);
  setJamDestination(jamId);
}
