import { useEffect, useRef } from 'react';
import { reportPlaying, reportProgress, reportStopped } from '../../api/jellyfin';
import { secondsToTicks } from '../../lib/domain/streamResolver';
import { useOptionalMusicPlayer } from './musicPlayerCore';

// Reports music playback to Jellyfin, the same way `usePlaybackHeartbeat` does
// for video: Sessions/Playing once per track, Sessions/Playing/Progress on a
// ~10s cadence, Sessions/Playing/Stopped when the track changes or the player
// goes away.
//
// This is what makes personalisation possible at all. Jellyfin keeps PlayCount
// and LastPlayedDate per user per item; until music reported anything, that
// history was empty and every user got the same feed. Reporting it means the
// taste profile is Jellyfin's own UserData — per user, persisted, backed up,
// with no new store to invent (see `usePersonalMusicFeed`).
//
// Preview tracks (a search hit streamed straight from YouTube) have no Jellyfin
// item, so there is nothing to report: their `itemId` is a videoId. They are
// skipped, which is also the honest thing — nothing was played *from the
// library*, and counting it would corrupt the profile with items that aren't
// there.

const PROGRESS_INTERVAL_MS = 10_000;

export function useMusicScrobble(): void {
  const player = useOptionalMusicPlayer();
  const current = player?.current ?? null;
  const isPlaying = player?.isPlaying ?? false;

  // Read through refs so the reporting effect keys only on the *track*, never
  // on the position ticking once a second.
  const positionRef = useRef(0);
  positionRef.current = player?.position ?? 0;
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  // A library track plays from a Jellyfin item; a preview carries a stream URL
  // and a videoId in `itemId`, which Jellyfin knows nothing about.
  const itemId = current && !current.streamUrl ? current.itemId : null;

  useEffect(() => {
    if (!itemId) return;
    // Position at the moment this track was torn down — captured before the
    // async stop report so it can't read the next track's position.
    let stopped = false;

    void reportPlaying({
      itemId,
      playSessionId: null,
      playMethod: 'DirectPlay',
      positionTicks: 0,
    }).catch(() => {
      // Reporting is best-effort: a failed report costs a little personalisation
      // accuracy, never playback.
    });

    const interval = setInterval(() => {
      if (stopped || !playingRef.current) return;
      void reportProgress({
        itemId,
        playSessionId: null,
        playMethod: 'DirectPlay',
        positionTicks: secondsToTicks(positionRef.current),
        isPaused: false,
      }).catch(() => {});
    }, PROGRESS_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(interval);
      // Jellyfin turns a Stopped report near the end of a track into a Played
      // mark + a PlayCount bump — the signal the whole feed is built on.
      void reportStopped({
        itemId,
        playSessionId: null,
        positionTicks: secondsToTicks(positionRef.current),
      }).catch(() => {});
    };
  }, [itemId]);
}
