import { useCallback, useEffect, useRef, useState } from 'react';
import { measureJamClockOffset } from '../../api/jam';
import type { JamSnapshot, JamTrack } from '../../api/schemas/jam';
import { buildAudioStreamUrl } from '../../lib/domain/streamResolver';
import { getSession } from '../../lib/session/store';
import { useOptionalMusicPlayer } from '../music/musicPlayerCore';
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

  const mode = snapshot?.jam.mode ?? 'king';
  const present = snapshot ? new Set(snapshot.present) : new Set<string>();
  const active = snapshot ? shouldSound(mode, ownUserId, snapshot.leaderId, present) : false;

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

  // The app's own player and the Jam cannot both own the speaker. The Jam is
  // the deliberate act, so it wins, and the other one stops.
  //
  // Watching `isPlaying` and not only the transition into `active`: the
  // NowPlayingBar stays mounted underneath this screen, so its play button is
  // reachable from inside a Jam room, and pressing it would leave two elements
  // sounding at once. Guarding on `active` is what keeps this from fighting
  // the user once they have left.
  const playerIsPlaying = player?.isPlaying ?? false;
  const playerToggle = player?.toggle;
  useEffect(() => {
    if (active && playerIsPlaying) playerToggle?.();
  }, [active, playerIsPlaying, playerToggle]);

  // Load the right track. Kept separate from the follow loop so a position
  // correction never reloads the source — assigning `src` restarts playback,
  // which would be audible on every single nudge.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !snapshot) return;
    if (!active) {
      audio.pause();
      return;
    }
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
