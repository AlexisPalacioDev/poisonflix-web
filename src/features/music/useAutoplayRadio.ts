import { useEffect, useRef } from 'react';
import { getRadio } from '../../api/music';
import { reportFailure } from '../../lib/obs/report';
import { searchResultToTrack } from '../../lib/domain/musicTrack';
import type { MusicSongResult } from '../../api/schemas/music';
import { useOptionalMusicPlayer } from './musicPlayerCore';

// How many related tracks each radio pull appends. The worker caps
// /recommendations at 25; this keeps the music going for a good while without
// making the queue drawer unreadable, and the pull simply repeats when the
// appended tail runs out — which is what makes the radio endless.
export const RADIO_SIZE = 15;

// Autoplay, the YouTube Music way: whatever you are playing — a search hit, an
// album, a playlist, the library — the queue keeps going once it runs out,
// continuing into a radio of related tracks. Mounted once next to the
// NowPlayingBar (see AppLayout), so every surface inherits it.
//
// It extends *ahead of time*: the moment the current track is the last one in
// play order, the next batch is fetched, so it is already queued when the track
// ends and playback never gaps. Repeat modes opt out — they never fall silent.
export function useAutoplayRadio(): void {
  // Soft accessor: AppLayout sits inside the router, so a route tree rendered
  // without the top-level provider (onboarding / route-guard tests) must not
  // crash here. No provider -> `autoplay` is false and the effect no-ops.
  const player = useOptionalMusicPlayer();
  const current = player?.current ?? null;
  const hasNext = player?.hasNext ?? true;
  const autoplay = player?.autoplay ?? false;
  const repeat = player?.repeat ?? 'off';

  // The player's context value is rebuilt on every tick, so `enqueue` is read
  // through a ref: the effect must not re-run (and re-fetch) on identity churn.
  const enqueueRef = useRef(player?.enqueue);
  enqueueRef.current = player?.enqueue;
  // The tail track a pull is in flight for, or that already came back empty.
  // Cleared on a pull that actually appended, so replaying the same track later
  // (or reaching it again) still gets a fresh radio instead of dead-ending.
  const seededRef = useRef<string | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    if (!autoplay || !current || hasNext || repeat !== 'off') return;
    const seedKey = current.videoId ?? current.itemId;
    if (seededRef.current === seedKey) return;
    seededRef.current = seedKey;
    const run = ++runRef.current;

    void (async () => {
      try {
        const related = await getRadio(
          current.videoId ? { videoId: current.videoId } : { itemId: current.itemId },
          RADIO_SIZE,
        );
        // A newer seed won while this was in flight — drop the stale batch.
        if (run !== runRef.current) return;
        const tracks = related
          .filter((item): item is MusicSongResult => item.type === 'song')
          .filter((song) => song.videoId !== current.videoId)
          .map(searchResultToTrack);
        if (tracks.length > 0) {
          enqueueRef.current?.(tracks);
          // Appended: hasNext now blocks the effect, so releasing the guard is
          // safe and keeps a later replay of this same track extendable.
          seededRef.current = null;
        }
      } catch (cause) {
        // Best-effort still — no radio just means the queue ends after this
        // track. But it leaves a trace now: the worker answers 200 with an empty
        // list when ytmusicapi fails, so "radio silently stopped" and "there was
        // nothing to play" were indistinguishable from here.
        reportFailure('music.autoplayRadio', cause, { seed: seedKey });
      }
    })();
  }, [autoplay, current, hasNext, repeat]);
}
