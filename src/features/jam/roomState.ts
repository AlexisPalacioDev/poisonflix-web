import { useSyncExternalStore } from 'react';
import type { JamPlayhead, JamTrack } from '../../api/schemas/jam';

// What the chosen room is doing, published where the rest of the app can read
// it.
//
// `destination.ts` answers "where does playback go". This answers "what is
// happening there", and the two together are what let a single control drive
// either channel. Before this existed the room's snapshot lived inside
// `JamPlaybackHost` and nowhere else, so pressing play with a Jam selected
// sent the track away and left the screen showing the local player's own,
// silent, unchanged state: the track went to the room and the interface said
// nothing had happened.
//
// Same shape as `destination.ts` on purpose — a module variable, a Set of
// listeners, `useSyncExternalStore`. The state is app-wide and singular (one
// output, one room), it is written by a component that renders in the header
// and read by one that renders at the bottom of the page, and neither is an
// ancestor of the other. A context would mean a provider wrapping the whole
// app to hold one object; a store library would mean a dependency for the
// same twenty lines.
//
// NOT persisted, unlike the destination: this is live state that belongs to
// the SSE stream. Restoring a stale playhead from localStorage on load would
// show a room playing a song it finished yesterday.

/** The room's current state, as far as this device knows it. */
export interface JamRoomState {
  jamId: string;
  /** Shown in the bar so it is never a mystery where the sound is going. */
  name: string;
  /** The track the playhead points at, or null while the queue is empty. */
  track: JamTrack | null;
  /** Index of `track` in `queue`. */
  index: number;
  /** The whole room queue, for the drawer the bar opens. */
  queue: JamTrack[];
  /** The room's playhead. Positions project forward from `at`; see
   *  `expectedPositionMs` in jamPlayhead.ts. */
  playhead: JamPlayhead;
  /** May this user press play/pause/next here — `canControlTransport` plus a
   *  live stream. False turns the bar's transport into a read-out. */
  canControl: boolean;
  /** False until the stream delivers its first frame, and again whenever it
   *  drops. The room state is then the last thing we were told, not the truth. */
  connected: boolean;
}

let current: JamRoomState | null = null;
const listeners = new Set<() => void>();

function sameTrack(a: JamTrack | null, b: JamTrack | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.itemId === b.itemId &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.coverUrl === b.coverUrl &&
    a.durationSeconds === b.durationSeconds
  );
}

// Identity by item id and position, which is what the queue drawer renders
// off. A track whose metadata changed in place without its id changing is not
// a case the server produces.
function sameQueue(a: JamTrack[], b: JamTrack[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((track, index) => track.itemId === b[index]?.itemId);
}

// Every SSE frame is a freshly parsed object, so the writer would hand us a
// new-but-identical state several times a second and `useSyncExternalStore`
// would re-render the bar on each one. Comparing by value here is what keeps
// `jamRoom()` referentially stable between real changes — which that hook
// requires of its `getSnapshot`, not merely prefers.
function same(a: JamRoomState | null, b: JamRoomState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.jamId === b.jamId &&
    a.name === b.name &&
    a.index === b.index &&
    sameQueue(a.queue, b.queue) &&
    a.canControl === b.canControl &&
    a.connected === b.connected &&
    a.playhead.index === b.playhead.index &&
    a.playhead.positionMs === b.playhead.positionMs &&
    a.playhead.isPlaying === b.playhead.isPlaying &&
    a.playhead.at === b.playhead.at &&
    sameTrack(a.track, b.track)
  );
}

/** The room playback is being sent to, or null when nothing is routed there. */
export function jamRoom(): JamRoomState | null {
  return current;
}

export function setJamRoom(next: JamRoomState | null): void {
  if (same(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders on change, including from another component. */
export function useJamRoom(): JamRoomState | null {
  return useSyncExternalStore(subscribe, jamRoom, () => null);
}
