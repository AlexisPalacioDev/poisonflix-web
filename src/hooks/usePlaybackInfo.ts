import { useQuery } from '@tanstack/react-query';
import { getItem, getPlaybackInfo } from '../api/jellyfin';
import { createBrowserDeviceProfile } from '../lib/domain/deviceProfile';
import { displayTitle } from '../lib/domain/displayTitle';
import { resolvePlayback, resumePositionMs, type ResolvedStream } from '../lib/domain/streamResolver';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Player's stream-resolution hook (design.md §2 `usePlaybackInfo`, tasks.md
// 7.1), ported from `StreamResolverImpl.resolve` (design.md §3.3/§10). Feeds
// Jellyfin's `PlaybackInfo` response into the already-validated
// `streamResolver.ts` (Slice 2's GO spike). `staleTime: 0` per design.md
// §4.2 - PlaybackInfo must reflect the server's current transcode decision
// on every play, never served stale from a previous visit.
//
// "Every play" does NOT mean "every time the tab regains focus" - hence the
// two `refetchOn*` opt-outs below. Jellyfin mints a FRESH `PlaySessionId` on
// every PlaybackInfo call, which changes the stream URL, which changes
// `VideoSurface`'s `sourceKey`, which tears down hls.js and reloads the
// <video> from zero. Measured live against 192.168.1.50:8600: alt-tab away
// from a movie at 43s and back, and the element emitted `emptied` ->
// `loadstart` -> `play` -> `waiting` with `currentTime` reset to 0 and a
// second `PlaySessionId` on the wire. `refetchOnReconnect` is the same
// mechanism behind a network blip. Neither event is a new play.
//
// Two SEPARATE mechanisms keep §4.2 honest without the focus refetch, and
// it takes both - do not assume either one covers the other:
//   - Opening the player fresh: `refetchOnMount` (default `true`) plus
//     `staleTime: 0` means the mount always re-resolves.
//   - Skipping to the next episode: `PlayerScreen` navigates with `replace`
//     and NEVER unmounts, so `refetchOnMount` does nothing there. What saves
//     that path is the query key changing with `itemId` (`queryKeys.ts`) -
//     a different key is a different query, so it fetches on its own.
//
// Also fetches the plain Jellyfin `Item` (not the Jellyseerr movie-details
// shape `useMovieDetail` uses) because resume position
// (`UserData.PlaybackPositionTicks`) and the display title only live on the
// Jellyfin item, not on Jellyseerr's TMDB-sourced payload.

export interface PlaybackData {
  resolved: ResolvedStream;
  /** Resume position already converted to seconds, ready for a `<video>`
   * seek - `0` means "no seek" per the player spec. */
  resumeSeconds: number;
  title: string;
  /** Jellyfin item `Type` ('Episode', 'Movie', ...) - the player only shows
   * episode prev/next/jump navigation when this is 'Episode' (owner request:
   * navigate between a series' chapters from the player). */
  type: string | null;
  /** The parent series' item id - only present on `Episode` items. Feeds
   * `useSeriesEpisodeList` to fetch the full episode list for prev/next. */
  seriesId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export function usePlaybackInfo(itemId: string) {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';
  const token = session?.jellyfinToken ?? '';

  return useQuery({
    queryKey: queryKeys.playbackInfo(itemId),
    queryFn: async (): Promise<PlaybackData> => {
      const [playbackInfo, item] = await Promise.all([
        // A real DeviceProfile (not `null`) is required so Jellyfin actually
        // enforces codec support instead of assuming DirectPlay is safe -
        // see deviceProfile.ts's header for the live-confirmed root cause.
        getPlaybackInfo(itemId, { userId, deviceProfile: createBrowserDeviceProfile() }),
        // Explicit UserData in Fields - PlaybackPositionTicks (resume) lives
        // there and the default `getItem` fields don't request it.
        getItem(userId, itemId, 'ProviderIds,MediaStreams,UserData'),
      ]);

      return {
        resolved: resolvePlayback(itemId, playbackInfo, token),
        resumeSeconds: resumePositionMs(item.UserData?.PlaybackPositionTicks) / 1000,
        title: displayTitle(item.Name),
        type: item.Type ?? null,
        seriesId: item.SeriesId ?? null,
        seasonNumber: item.ParentIndexNumber ?? null,
        episodeNumber: item.IndexNumber ?? null,
      };
    },
    enabled: Boolean(itemId && userId && token),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
