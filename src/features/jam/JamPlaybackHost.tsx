import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listJams } from '../../api/jam';
import { canControlTransport } from '../../lib/domain/jam';
import { queryKeys } from '../../hooks/queryKeys';
import { useAuth } from '../../hooks/useAuth';
import { setJamDestination, useJamDestination } from './destination';
import { setJamRoom } from './roomState';
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
  // No session, no room: hooks run above the `!session` bail-out below, so
  // without this a logged-out tab would still open the stream, be refused
  // three times, and — since a refusal now clears the destination — throw away
  // an output the user chose while logged in.
  const { snapshot, connected, denied } = useJamStream(session ? destination : null);

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
  //
  // Two independent ways to find out, and both are needed. The list says the
  // room is no longer ours, but only as often as the query refetches — it has
  // no interval, so on a quiet screen that can be never. The stream says so
  // within seconds, because being removed from a room is exactly what makes it
  // refuse to open (`denied`); ignoring that, as this component used to, left
  // someone's music routed into a room they had been thrown out of, waiting
  // for a refetch that was not coming.
  //
  // Both verdicts wait for the list to have loaded, which is what keeps a
  // refusal distinguishable from an outage. A phone with no signal fails the
  // stream three times over — the same shape as being thrown out — but it
  // fails the list too, so nothing is concluded and the chosen output survives
  // the tunnel. A list that loaded while the stream will not open is a
  // refusal, not a network.
  //
  // From an effect, never during render. `setJamDestination` notifies its
  // `useSyncExternalStore` listeners synchronously — this component among
  // them — and React answers a render-phase update to another component with
  // a warning and, under concurrent rendering, a dropped update. Same reason
  // the room state below is published from an effect.
  const stillMine = (jamsQuery.data ?? []).some(
    (entry) => entry.jam.id === destination && entry.myRole?.acceptedAt != null,
  );
  const listSettled = jamsQuery.isSuccess;
  useEffect(() => {
    if (!destination || !listSettled) return;
    if (denied || !stillMine) setJamDestination(null);
  }, [destination, denied, listSettled, stillMine]);

  // Publish the room so the NowPlayingBar can be the control for it.
  //
  // The list entry is the fallback while the stream is still opening: it
  // carries the same snapshot shape, only stale. Without it the bar would have
  // nothing to show for the second or two between choosing a room and the
  // first SSE frame — the exact window in which someone presses play and
  // wonders whether the button works.
  //
  // It is the fallback on every switch, not just the first: `useJamStream`
  // hands back no snapshot until the room being asked about has sent one, so
  // moving from one room to another lands here — the new room's name, from the
  // list, with `connected` false — instead of on the old room's live-looking
  // state.
  const listEntry = useMemo(
    () => (jamsQuery.data ?? []).find((entry) => entry.jam.id === destination) ?? null,
    [jamsQuery.data, destination],
  );
  const view = snapshot ?? listEntry;
  useEffect(() => {
    // Writing from an effect, never during render: `setJamRoom` notifies its
    // listeners synchronously, and notifying a subscriber mid-render is how
    // you get React tearing warnings and updates dropped on the floor.
    if (!destination || !view) {
      setJamRoom(null);
      return;
    }
    const { jam } = view;
    const present = new Set(view.present);
    setJamRoom({
      jamId: jam.id,
      name: jam.name,
      track: jam.queue[jam.current.index] ?? null,
      index: jam.current.index,
      queue: jam.queue,
      playhead: jam.current,
      // Presence is this component's SSE connection, so a dropped stream is
      // also a lost seat: `connected` gates the rights, not just the display.
      canControl: connected && ownUserId != null && canControlTransport(jam, present, ownUserId),
      connected,
    });
  }, [destination, view, ownUserId, connected]);

  // The header swaps between a compact and a wide branch, each with its own
  // JamPlaybackHost, so this runs on a layout change as well as on logout.
  // Leaving the last room state behind would leave the bar controlling a room
  // nothing is connected to.
  useEffect(() => () => setJamRoom(null), []);

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
