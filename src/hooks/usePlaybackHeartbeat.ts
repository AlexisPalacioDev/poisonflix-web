import { useCallback, useEffect, useRef } from 'react';
import { reportPlaying, reportProgress, reportStopped } from '../api/jellyfin';
import { secondsToTicks } from '../lib/domain/streamResolver';

// Jellyfin playback-progress heartbeat (design.md §10, ← `PlaybackController.kt`
// reporting cadence via `JellyfinApi.kt` L102-109; player spec's "Playback
// progress heartbeat" requirement, tasks.md 7.4): `Sessions/Playing` exactly
// once at start, `Sessions/Progress` on a recurring ~10s cadence while
// playing, and `Sessions/Stopped` on pause/unmount/navigation - always
// clearing the interval alongside a Stopped report so no orphaned reports
// are ever sent after the fact.

const PROGRESS_INTERVAL_MS = 10_000;

export interface UsePlaybackHeartbeatParams {
  itemId: string;
  playSessionId: string | null;
  /** Reads the current playback position in seconds at report time - kept as
   * a function rather than a stored value so every report carries the
   * freshest position without re-subscribing to every `timeupdate` tick. */
  getPositionSeconds: () => number;
  playMethod?: string;
}

interface HeartbeatParamsSnapshot {
  itemId: string;
  playSessionId: string | null;
  getPositionSeconds: () => number;
  playMethod: string;
}

export function usePlaybackHeartbeat({
  itemId,
  playSessionId,
  getPositionSeconds,
  playMethod = 'DirectPlay',
}: UsePlaybackHeartbeatParams) {
  const startedRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Kept in a ref (not deps) so start/stop's identity stays stable across
  // renders (they're wired straight into <video> event handlers) without
  // ever reading a stale itemId/playSessionId/position-getter closure.
  //
  // Written from an EFFECT (post-commit), not during render. This one
  // matters: React runs, in a single commit, ALL effect cleanups first and
  // ONLY THEN all effect setups - so as long as the write happens in a
  // setup (this effect, no deps -> re-runs every commit), the `[itemId]`
  // cleanup effect below is GUARANTEED to still see the PREVIOUS commit's
  // values when it tears down for the item being left. A render-time write
  // (the original approach) lands before ANY effect runs in that same
  // commit, so on an `itemId` change the cleanup would already observe the
  // NEW item's (often not-yet-resolved) `playSessionId` instead of the old
  // one - live-reproduced by the episode prev/next feature (the first
  // caller to change `itemId` on an already-mounted PlayerScreen without a
  // full remount): the OLD episode's session was NEVER reported Stopped
  // (a dangling Jellyfin session + a lost resume position), while a bogus
  // Stopped fired for the NEW episode with `playSessionId: null`.
  const paramsRef = useRef<HeartbeatParamsSnapshot>({ itemId, playSessionId, getPositionSeconds, playMethod });
  useEffect(() => {
    paramsRef.current = { itemId, playSessionId, getPositionSeconds, playMethod };
  });

  const clearProgressInterval = useCallback(() => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearProgressInterval();
    if (!startedRef.current) return;
    startedRef.current = false;
    const { itemId: id, playSessionId: sessionId, getPositionSeconds: getPos } = paramsRef.current;
    void reportStopped({ itemId: id, playSessionId: sessionId, positionTicks: secondsToTicks(getPos()) });
  }, [clearProgressInterval]);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const { itemId: id, playSessionId: sessionId, getPositionSeconds: getPos, playMethod: method } = paramsRef.current;
    void reportPlaying({
      itemId: id,
      playSessionId: sessionId,
      playMethod: method,
      positionTicks: secondsToTicks(getPos()),
    });

    clearProgressInterval();
    intervalRef.current = setInterval(() => {
      const current = paramsRef.current;
      void reportProgress({
        itemId: current.itemId,
        playSessionId: current.playSessionId,
        playMethod: current.playMethod,
        positionTicks: secondsToTicks(current.getPositionSeconds()),
      });
    }, PROGRESS_INTERVAL_MS);
  }, [clearProgressInterval]);

  // Unmount / navigation-away: report Stopped and clear the interval exactly
  // once, even if the video element never fired its own pause/ended event
  // first (e.g. the user clicks "back" mid-playback).
  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  return { onPlay: start, onPause: stop, onEnded: stop };
}
