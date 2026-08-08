import { useEffect, useState } from 'react';
import { JamSnapshotSchema, type JamSnapshot } from '../../api/schemas/jam';

// The live room. One `EventSource` per open jam, and the fact that it is open
// is what puts this user in the room — presence is the connection, not a
// heartbeat we have to remember to send. Closing this component, navigating
// home, locking the phone until the socket dies: all of them are "left the
// room", and all of them are answered by reopening.
//
// EventSource reconnects on its own with backoff, which is exactly the
// behaviour a phone on mobile data needs going through a tunnel. What it does
// NOT do is tell us it is trying, so `connected` is driven off the events we
// actually receive rather than off a promise that the socket is healthy.

export interface JamStream {
  /** The last frame received **for the room currently being asked about**, and
   *  null until one arrives. Never another room's: switching rooms empties
   *  this in the same render, so a caller holding a snapshot can always act on
   *  it — send transport, name the room, follow the playhead — without
   *  checking which room it came from. */
  snapshot: JamSnapshot | null;
  /** True once a snapshot has arrived and the stream has not errored since.
   *  While false the room is stale and the UI should say so rather than let
   *  someone press buttons that will not land. */
  connected: boolean;
  /** The stream never opened at all and we stopped trying — almost always
   *  because this user is no longer allowed in the room. Distinct from
   *  `!connected`, which is an ordinary drop that will heal by itself. */
  denied: boolean;
}

/** Everything this hook knows, in one value stamped with the room it came
 *  from.
 *
 *  The stamp is the whole point. A React state update is asynchronous and a
 *  `jamId` change is not: for at least one render the state still holds the
 *  previous room, and nothing in the shape of three loose `useState`s could
 *  say so. That gap is not cosmetic — `JamPlaybackHost` publishes this
 *  snapshot as "the room you are playing into", so a leftover meant the bar
 *  named the old room, claimed to be connected to it, and sent transport
 *  commands to it while the destination had already moved on. Pausing a room
 *  you just left, for everyone in it.
 *
 *  One object rather than three states so the id and the data it describes
 *  can never disagree: every write stamps them together, and every read
 *  checks the stamp. */
interface RoomState {
  jamId: string | null;
  snapshot: JamSnapshot | null;
  connected: boolean;
  denied: boolean;
}

export function useJamStream(jamId: string | null): JamStream {
  const [state, setState] = useState<RoomState>({
    jamId,
    snapshot: null,
    connected: false,
    denied: false,
  });

  useEffect(() => {
    // Forget the previous room. The read below already hides it from this
    // render, so nothing on screen changes here — this is what stops it coming
    // BACK. Leaving a room and choosing it again is the case that makes the
    // difference: the id matches what the leftover state is stamped with, so
    // without this the previous visit's snapshot would be handed out as if the
    // new stream had already answered, `connected` and all, off a playhead
    // from minutes ago that the follower would faithfully seek to.
    //
    // Returning `prev` unchanged when the stamp already matches is not an
    // optimisation, it is what keeps this from looping: React bails out of an
    // update that returns the same object, so this costs one render per room
    // change and nothing at all otherwise.
    //
    // An effect and not the render body, tempting as `if (state.jamId !==
    // jamId) setState(...)` is. React sanctions that pattern, but this
    // component's destination comes from a `useSyncExternalStore`, and a
    // render-phase update here makes the very next store notification vanish:
    // choosing a room, then this device, then the same room again left the
    // component never re-rendering for the third change. Measured, not
    // theorised — the render log stopped dead and no stream was ever opened.
    setState((prev) =>
      prev.jamId === jamId ? prev : { jamId, snapshot: null, connected: false, denied: false },
    );
    if (!jamId) return;

    // Per stream, not per hook. These were refs, shared by every room this
    // component ever followed, and a closed room kept writing to them: an
    // error counted against room A brought room B one step closer to being
    // declared refused, and a high `seq` from A made every lower-numbered
    // frame of B look stale enough to drop — permanently.
    //
    // `lastSeq` is the last sequence rendered. The server is the only thing
    // that assigns it, so ignoring anything older makes an out-of-order or
    // duplicated event — a reconnect replaying current state, say — a no-op
    // instead of a flicker back to something stale.
    let lastSeq = -1;
    let failures = 0;
    // Closing an EventSource stops its events, but a frame already dispatched
    // is already on its way. Nothing from a stream this hook has let go of may
    // land on the room that replaced it.
    let live = true;

    const source = new EventSource(`/bff/jam/${encodeURIComponent(jamId)}/stream`, {
      withCredentials: true,
    });

    /** No longer receiving, but what it last said is still the best guess at
     *  the room — flagged stale rather than blanked. `prev` is always this
     *  room's: only the open stream gets here, and the reset above has already
     *  landed by the time any event can. */
    const markDropped = () => {
      setState((prev) => (prev.connected ? { ...prev, connected: false } : prev));
    };

    source.onmessage = (event: MessageEvent<string>) => {
      if (!live) return;
      const parsed = JamSnapshotSchema.safeParse(JSON.parse(event.data));
      // A malformed frame is dropped rather than thrown: one bad event must
      // not tear down a room that is otherwise fine.
      if (!parsed.success) return;
      if (parsed.data.jam.seq < lastSeq) return;
      lastSeq = parsed.data.jam.seq;
      setState({ jamId, snapshot: parsed.data, connected: true, denied: false });
    };

    source.onerror = () => {
      if (!live) return;
      // EventSource will retry by itself, which is what a phone going through
      // a tunnel needs. But it retries just as happily against a 403, and the
      // API gives no way to tell the two apart — the error event carries no
      // status. So a member who was removed from the room would sit on
      // "reconnecting" for ever while the server refused them every time.
      //
      // Failing without ever having received a single frame is the signal:
      // a real reconnect resumes a stream that worked before, a refusal never
      // starts one. After a few of those, stop and say so.
      if (lastSeq >= 0) {
        // It worked once; this is a real drop.
        markDropped();
        return;
      }
      failures += 1;
      if (failures < 3) {
        markDropped();
        return;
      }
      source.close();
      setState({ jamId, snapshot: null, connected: false, denied: true });
    };

    return () => {
      live = false;
      source.close();
    };
  }, [jamId]);

  // The read that makes a switch instant. An effect runs after the render that
  // changed `jamId`, so the reset above is always one cycle late — this is
  // what makes that harmless: state belonging to a room this hook is no longer
  // following is not stale data to be shown until something better arrives, it
  // is data about somewhere else, and there is nothing to show for a room whose
  // first frame has not landed yet. Saying so — `connected: false` — is what
  // lets the caller tell "opening" from "live", the distinction a leftover
  // snapshot erased.
  const current = state.jamId === jamId ? state : null;
  return {
    snapshot: current?.snapshot ?? null,
    connected: current?.connected ?? false,
    denied: current?.denied ?? false,
  };
}
