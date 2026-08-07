import { useEffect, useRef, useState } from 'react';
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

export function useJamStream(jamId: string | null): JamStream {
  const [snapshot, setSnapshot] = useState<JamSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [denied, setDenied] = useState(false);
  const failures = useRef(0);

  // The last sequence rendered. The server is the only thing that assigns
  // `seq`, so dropping anything not newer makes an out-of-order or duplicated
  // event — a reconnect replaying the current state, say — a no-op instead of
  // a flicker back to something stale.
  const lastSeq = useRef(-1);

  useEffect(() => {
    if (!jamId) {
      setSnapshot(null);
      setConnected(false);
      return;
    }
    lastSeq.current = -1;
    failures.current = 0;
    setDenied(false);
    const source = new EventSource(`/bff/jam/${encodeURIComponent(jamId)}/stream`, {
      withCredentials: true,
    });

    source.onmessage = (event: MessageEvent<string>) => {
      const parsed = JamSnapshotSchema.safeParse(JSON.parse(event.data));
      // A malformed frame is dropped rather than thrown: one bad event must
      // not tear down a room that is otherwise fine.
      if (!parsed.success) return;
      if (parsed.data.jam.seq < lastSeq.current) return;
      lastSeq.current = parsed.data.jam.seq;
      setSnapshot(parsed.data);
      setConnected(true);
    };

    source.onerror = () => {
      // EventSource will retry by itself, which is what a phone going through
      // a tunnel needs. But it retries just as happily against a 403, and the
      // API gives no way to tell the two apart — the error event carries no
      // status. So a member who was removed from the room would sit on
      // "reconnecting" for ever while the server refused them every time.
      //
      // Failing without ever having received a single frame is the signal:
      // a real reconnect resumes a stream that worked before, a refusal never
      // starts one. After a few of those, stop and say so.
      setConnected(false);
      if (lastSeq.current >= 0) return; // it worked once; this is a real drop
      failures.current += 1;
      if (failures.current >= 3) {
        source.close();
        setDenied(true);
      }
    };

    return () => {
      source.close();
    };
  }, [jamId]);

  return { snapshot, connected, denied };
}
