import { useQuery } from '@tanstack/react-query';
import { getItem, getPlaybackInfo } from '../api/jellyfin';
import { createBrowserDeviceProfile } from '../lib/domain/deviceProfile';
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
        title: item.Name,
      };
    },
    enabled: Boolean(itemId && userId && token),
    staleTime: 0,
    retry: false,
  });
}
