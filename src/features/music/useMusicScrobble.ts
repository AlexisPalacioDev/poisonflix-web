import { useEffect, useRef } from 'react';
import { reportPlaying, reportProgress, reportStopped } from '../../api/jellyfin';
import { reportPreviewPlay } from '../../api/music';
import { reportFailure } from '../../lib/obs/report';
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
// Preview tracks (a search hit or radio pick streamed straight from YouTube)
// have no Jellyfin item, so nothing can be reported to Jellyfin: their `itemId`
// is a videoId Jellyfin has never heard of, and writing one would corrupt the
// profile with items that aren't there.
//
// They are not simply dropped, though. Since autoplay radio landed, previews
// are MOST of what actually plays, so ignoring them left the user's own stats
// reading near zero while they listened every day. They go to the worker's
// videoId-keyed tally instead — a second store, because the first one
// structurally cannot hold them.

const PROGRESS_INTERVAL_MS = 10_000;

// Below this, a track was skipped through rather than listened to. Radio queues
// get skipped a lot, and a tally that counts skips is just a queue-length
// counter wearing a different label.
const MIN_LISTEN_SECONDS = 30;

/**
 * Whether a preview was listened to rather than skipped through.
 *
 * Exported because it is the only interesting rule here and the hook itself
 * cannot be driven to a non-zero position under jsdom (position comes from a
 * real <audio> element), so testing it through the hook would prove nothing.
 *
 * Short tracks use half their length instead of the flat 30s: a 40-second
 * interlude played to the end is a listen, and a fixed threshold would silently
 * make short tracks uncountable.
 */
export function countsAsListen(positionSeconds: number, durationSeconds: number): boolean {
  const threshold =
    durationSeconds > 0 ? Math.min(MIN_LISTEN_SECONDS, durationSeconds / 2) : MIN_LISTEN_SECONDS;
  return positionSeconds >= threshold;
}

export function useMusicScrobble(): void {
  const player = useOptionalMusicPlayer();
  const current = player?.current ?? null;
  const isPlaying = player?.isPlaying ?? false;

  // Read through refs so the reporting effect keys only on the *track*, never
  // on the position ticking once a second.
  const positionRef = useRef(0);
  positionRef.current = player?.position ?? 0;

  // The LAST NON-ZERO position seen for the current track.
  //
  // `positionRef` alone cannot be used at teardown. It is assigned during render,
  // and every track change resets position to 0 in the same reducer step, so the
  // render that precedes cleanup has already written 0. Cleanup therefore always
  // read 0: `countsAsListen(0, …)` was never true, so `reportPreviewPlay` never
  // fired at all, and Jellyfin got `positionTicks: 0` — which it will not turn
  // into a Played mark. The feed had no history to work from and the user's stats
  // read zero while they listened every day.
  //
  // Ignoring zero is what makes this survive the reset. React runs cleanup BEFORE
  // the next effect setup, so the outgoing track reads its own last good value and
  // the incoming one starts from a clean slate.
  const lastGoodPositionRef = useRef(0);
  if (positionRef.current > 0) lastGoodPositionRef.current = positionRef.current;
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  // A library track plays from a Jellyfin item; a preview carries a stream URL
  // and a videoId in `itemId`, which Jellyfin knows nothing about.
  const itemId = current && !current.streamUrl ? current.itemId : null;

  useEffect(() => {
    if (!itemId) return;
    lastGoodPositionRef.current = 0;
    let stopped = false;

    void reportPlaying({
      itemId,
      playSessionId: null,
      playMethod: 'DirectPlay',
      positionTicks: 0,
    }).catch((cause: unknown) => {
      // Best-effort still: a failed report must never break playback. But it now
      // leaves a trace — a silent catch is why this whole path could be dead for
      // weeks without anyone noticing.
      reportFailure('music.scrobble.playing', cause, { itemId });
    });

    const interval = setInterval(() => {
      if (stopped || !playingRef.current) return;
      void reportProgress({
        itemId,
        playSessionId: null,
        playMethod: 'DirectPlay',
        positionTicks: secondsToTicks(positionRef.current),
        isPaused: false,
      }).catch((cause: unknown) => reportFailure('music.scrobble.progress', cause, { itemId }));
    }, PROGRESS_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(interval);
      // Jellyfin turns a Stopped report near the end of a track into a Played
      // mark + a PlayCount bump — the signal the whole feed is built on.
      void reportStopped({
        itemId,
        playSessionId: null,
        positionTicks: secondsToTicks(lastGoodPositionRef.current),
      }).catch((cause: unknown) => reportFailure('music.scrobble.stopped', cause, { itemId }));
    };
  }, [itemId]);

  // The preview half. Read off the track rather than the player so the effect
  // keys on the TRACK, same as above.
  const previewVideoId = current?.streamUrl ? (current.videoId ?? null) : null;
  const previewTitle = current?.title ?? '';
  const previewArtist = current?.artist ?? '';
  const previewSeconds = current?.durationSeconds ?? 0;

  useEffect(() => {
    if (!previewVideoId) return;
    lastGoodPositionRef.current = 0;

    // Counted on teardown, not on start — mirroring how Jellyfin only turns a
    // *Stopped* report into a PlayCount. Starting a track is not listening to
    // it.
    return () => {
      if (!countsAsListen(lastGoodPositionRef.current, previewSeconds)) return;

      void reportPreviewPlay({
        videoId: previewVideoId,
        title: previewTitle,
        artist: previewArtist,
        seconds: Math.round(previewSeconds),
      }).catch((cause: unknown) => {
        reportFailure('music.scrobble.preview', cause, { videoId: previewVideoId });
      });
    };
  }, [previewVideoId, previewTitle, previewArtist, previewSeconds]);
}
