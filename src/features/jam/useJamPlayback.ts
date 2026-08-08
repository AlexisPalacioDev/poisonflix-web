import { useCallback, useEffect, useRef, useState } from 'react';
import { measureJamClockOffset, sendJamTransport } from '../../api/jam';
import type { JamSnapshot, JamTrack } from '../../api/schemas/jam';
import { buildAudioStreamUrl } from '../../lib/domain/streamResolver';
import { getSession } from '../../lib/session/store';
import { useOptionalMusicPlayer } from '../music/musicPlayerCore';
import { useJamDestination } from './destination';
import { followPlayhead, shouldSound } from './jamPlayhead';

// Makes a device actually play what the room is playing.
//
// One follower drives BOTH modes, because they differ in exactly one place —
// whether this device should be making sound at all (`shouldSound`). In `king`
// only the acting leader's phone sounds and everyone else is a remote; in
// `everyone` each attached member plays, which is the motorcycle case.
//
// The iOS constraint shapes the whole thing. A remote "play" arriving over SSE
// is not a user gesture, so `audio.play()` from inside it is refused on a
// phone that has not been touched. The gesture that unlocks the element is
// entering the room — the owner's own framing: the button to join the Jam is
// the button to start listening. `unlock()` below must therefore be called
// SYNCHRONOUSLY from that click, before React flushes anything.

/** How often to compare this device against the room while playing. Often
 *  enough to correct before anyone notices, rare enough to be free. */
const FOLLOW_INTERVAL_MS = 700;

function trackSrc(track: JamTrack | null): string | null {
  if (!track) return null;
  if (track.streamUrl) return track.streamUrl;
  const session = getSession();
  if (!track.itemId || !session?.jellyfinUserId || !session?.jellyfinToken) return null;
  return buildAudioStreamUrl(track.itemId, session.jellyfinUserId, session.jellyfinToken);
}

/**
 * Mark an audio element as user-activated.
 *
 * Playing and immediately pausing inside a real gesture is what buys the
 * element the right to be played later without one. It makes no sound: there
 * is no source loaded yet, and the pause lands in the same tick.
 *
 * Exported because the gesture that matters happens BEFORE the room exists:
 * the click that opens a Jam is on the list screen, so that screen owns the
 * element and unlocks it there, while the room does the following.
 */
export function unlockAudioElement(audio: HTMLAudioElement | null): Promise<boolean> {
  if (!audio) return Promise.resolve(false);
  try {
    const started = audio.play();
    audio.pause();
    if (started && typeof started.then === 'function') {
      return started.then(
        () => true,
        () => false,
      );
    }
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

export interface JamPlayback {
  /** True when this device is one of the ones meant to be making sound. */
  active: boolean;
  /** Call synchronously from the click that opens the room. Unlocks the audio
   *  element for later, gesture-less play() calls driven by the room. */
  unlock: (audio: HTMLAudioElement | null) => void;
  /** The element never got its gesture, so the room can play without this
   *  device following. The UI offers a button rather than failing silently. */
  needsGesture: boolean;
}

export function useJamPlayback(
  snapshot: JamSnapshot | null,
  ownUserId: string | null,
  audioRef: { current: HTMLAudioElement | null },
): JamPlayback {
  const [needsGesture, setNeedsGesture] = useState(false);
  const [clockReady, setClockReady] = useState(false);
  const unlockedRef = useRef(false);
  // Difference between this device's clock and the server's. A phone can be
  // minutes out, and every projection of the playhead is relative to the
  // server's clock, so this is measured rather than assumed.
  const clockOffsetRef = useRef(0);
  // What was last assigned to the element, so reloads only happen on a real
  // track change.
  const lastSrcRef = useRef<string | null>(null);
  const player = useOptionalMusicPlayer();

  // The chosen output, not the room state, is what decides which element owns
  // the speaker. It changes the instant the card is tapped, while `snapshot`
  // only catches up when SSE says so — and for the one render in between, the
  // stale snapshot still says "keep playing".
  const routedToJam = useJamDestination() != null;

  const mode = snapshot?.jam.mode ?? 'king';
  const present = snapshot ? new Set(snapshot.present) : new Set<string>();
  const active =
    routedToJam && snapshot ? shouldSound(mode, ownUserId, snapshot.leaderId, present) : false;

  // Only `everyone` mode has anything to agree about: in `king` a single
  // device makes the sound, so four round trips per room opening would buy
  // nothing.
  const needsClock = mode === 'everyone';
  useEffect(() => {
    if (!needsClock) {
      setClockReady(true);
      return;
    }
    let cancelled = false;
    void measureJamClockOffset()
      .then((offset) => {
        if (!cancelled) clockOffsetRef.current = offset;
      })
      .finally(() => {
        // Ready on failure too: falling back to the raw device clock is worse
        // than a measured offset but far better than never playing.
        if (!cancelled) setClockReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsClock]);

  const unlock = useCallback((audio: HTMLAudioElement | null) => {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    setNeedsGesture(false);
    void unlockAudioElement(audio).then((ok) => {
      if (ok) return;
      unlockedRef.current = false;
      setNeedsGesture(true);
    });
  }, []);

  // Leaving the room silences this device. The <audio> element deliberately
  // lives in JamScreen so it survives the switch between the list and a room —
  // which also means nothing unmounts it when you press back, and without this
  // the song kept playing with no UI anywhere to stop it.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) audio.pause();
    };
  }, [audioRef]);

  // The app's own player and the Jam cannot both own the speaker. The chosen
  // output wins, and the other one stops.
  //
  // Keyed on `routedToJam` rather than `active`: picking a room is the choice,
  // and it has to silence the local element immediately — waiting for `active`
  // left the local song playing for the whole SSE round trip, and left it
  // playing forever in `king` mode for anyone who is not the acting leader,
  // whose device is a remote and is meant to be silent.
  //
  // Watching `isPlaying` and not only the transition, and STILL necessary now
  // that the bar's play button sends transport to the room instead of toggling
  // the local element. The bar was never the only thing that could start local
  // playback: the lock-screen MediaSession handlers call the local player's
  // TOGGLE directly, and `advanceFromMediaEvent` sets `isPlaying` from the
  // element's own `ended`/`error` events — either can wake the local element
  // while a Jam owns the speaker. It also remains what silences a local track
  // the instant a room is chosen mid-song.
  //
  // It cannot fight the user, because with a Jam selected there is no longer
  // any path that deliberately asks for local sound: `playNow` and `enqueue`
  // both route to the room (MusicPlayerProvider's `sendToJam`), and the bar's
  // transport does too. Every remaining caller is something to override.
  const playerIsPlaying = player?.isPlaying ?? false;
  const playerToggle = player?.toggle;
  useEffect(() => {
    if (routedToJam && playerIsPlaying) playerToggle?.();
  }, [routedToJam, playerIsPlaying, playerToggle]);

  // The volume slider in the bar sets the app's volume, and while a Jam is the
  // output THIS element is the one making sound — so it has to obey it too, or
  // the control would be visibly present and audibly inert.
  const playerVolume = player?.volume ?? 1;
  const playerMuted = player?.muted ?? false;
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = playerVolume;
    audio.muted = playerMuted;
  }, [playerVolume, playerMuted, audioRef]);

  // Load the right track. Kept separate from the follow loop so a position
  // correction never reloads the source — assigning `src` restarts playback,
  // which would be audible on every single nudge.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Silence comes before every other consideration, and before the snapshot
    // check in particular. Leaving a room clears the snapshot in the same
    // cycle that clears `active`, so a `!snapshot` guard placed above this one
    // returned early and the room's song kept playing on top of whatever the
    // local player started next — two tracks at once, which is the bug this
    // ordering exists to prevent.
    if (!active) {
      audio.pause();
      return;
    }
    if (!snapshot) return;
    const track = snapshot.jam.queue[snapshot.jam.current.index] ?? null;
    const src = trackSrc(track);
    if (!src) {
      // Paired with pause() + load(), the way MusicPlayerProvider does it:
      // dropping the attribute alone does not oblige the element to let go of
      // a resource it has already buffered.
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      lastSrcRef.current = null;
      return;
    }
    // Compared against what was last ASSIGNED, not against `audio.src`. The
    // DOM resolves that to an absolute URL, so comparing it with the relative
    // one this builds is always unequal — which meant reassigning and
    // reloading on every snapshot, and a snapshot arrives on every transport
    // command. Playback restarted from zero on each one and the follower then
    // seeked back, so it recovered, audibly, every single time.
    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      audio.src = src;
      audio.load();
    }
  }, [active, snapshot, audioRef]);

  // Advance the queue when a track runs out.
  //
  // Nothing did this, and the room's playhead is a free-running clock that
  // knows nothing about how long a track is: after a 247-second song it had
  // counted to 3034 and was still claiming to play, with the queue never
  // moving. A Jam played one track and then sat there.
  //
  // Only the acting leader reports it. Every attached device reaches the end
  // at roughly the same moment and `next` advances by one per call, so N
  // devices reporting would skip N-1 tracks.
  const amLeader = snapshot?.leaderId != null && snapshot.leaderId === ownUserId;
  const jamId = snapshot?.jam.id ?? null;
  const atLastTrack =
    snapshot != null && snapshot.jam.current.index >= snapshot.jam.queue.length - 1;
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !active || !amLeader || !jamId) return;
    const onEnded = () => {
      // At the end of the queue there is nowhere to go, and leaving the room
      // "playing" is what let the clock run away past the track in the first
      // place.
      void sendJamTransport(jamId, atLastTrack ? { type: 'pause' } : { type: 'next' }).catch(
        () => undefined,
      );
    };
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, [active, amLeader, jamId, atLastTrack, audioRef]);

  // Follow the playhead: on every snapshot, and on a timer in between, because
  // drift accumulates silently while nothing is being broadcast.
  useEffect(() => {
    // Waiting for the offset before the first comparison. A phone's raw clock
    // can be minutes out, and `expectedPositionMs` is measured against the
    // server's — running one step at offset 0 would compute a wild target and
    // seek to it, an audible jump at the exact moment this feature is meant to
    // be careful.
    if (!active || !snapshot || !clockReady) return;
    const step = () => {
      const audio = audioRef.current;
      if (!audio) return;
      const action = followPlayhead({
        target: snapshot.jam.current,
        serverNow: Date.now() + clockOffsetRef.current,
        localPositionMs: audio.currentTime * 1000,
        localPlaying: !audio.paused,
      });
      switch (action.kind) {
        case 'pause':
          audio.pause();
          break;
        case 'play': {
          audio.currentTime = action.positionMs / 1000;
          const started = audio.play();
          if (started && typeof started.catch === 'function') {
            // Autoplay refused: this device never received its gesture. Say so
            // rather than sitting silent while everyone else hears the song.
            started.catch(() => setNeedsGesture(true));
          }
          break;
        }
        case 'seek':
          audio.currentTime = action.positionMs / 1000;
          break;
        case 'rate':
          if (audio.playbackRate !== action.rate) audio.playbackRate = action.rate;
          break;
        case 'hold':
          break;
      }
    };
    step();
    const timer = window.setInterval(step, FOLLOW_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, snapshot, audioRef, clockReady]);

  return { active, unlock, needsGesture };
}
