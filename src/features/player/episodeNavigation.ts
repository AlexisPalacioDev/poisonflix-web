import { useQuery } from '@tanstack/react-query';
import { getItems } from '../../api/jellyfin';
import { queryKeys } from '../../hooks/queryKeys';

// Episode prev/next/jump-to-episode navigation for the player (owner
// request: navigate between a series' chapters from the player itself).
//
// Deliberately NOT built on `hooks/useSeriesEpisodes.ts` (Detail's two-pane
// hook): that hook requires a `tmdbId` the player never has, merges in
// Sonarr's full/not-yet-downloaded episode list, and polls every 15s - none
// of which this menu needs. This is a plain Jellyfin-only fetch of the
// series' PLAYABLE episodes, sorted once and reused for both the prev/next
// buttons and the jump menu.

export interface EpisodeNavItem {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  /** `ImageTags.Primary` - an episode's own still frame, which is what the
   *  jump menu shows as its thumbnail. Not gated behind the `Fields`
   *  whitelist (verified live: episodes carry it under `getItems`'s default
   *  fields), so listing it costs no extra request. `null` when the episode
   *  has no artwork and the menu should fall back to a text-only row. */
  imageTag: string | null;
}

/** Natural episode order - (season, episode) ascending. This single sort is
 * also what makes "next" cross a season boundary for free: the last episode
 * of S01 sits immediately before S02's first episode in this array, so no
 * special-casing is needed at the call site. */
export function sortEpisodes(episodes: EpisodeNavItem[]): EpisodeNavItem[] {
  return [...episodes].sort(
    (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
  );
}

/** `null` when `currentId` is the first episode, or not found in `sorted`. */
export function previousEpisode(sorted: EpisodeNavItem[], currentId: string): EpisodeNavItem | null {
  const index = sorted.findIndex((episode) => episode.id === currentId);
  if (index <= 0) return null;
  return sorted[index - 1];
}

/** `null` when `currentId` is the last episode, or not found in `sorted`. */
export function nextEpisode(sorted: EpisodeNavItem[], currentId: string): EpisodeNavItem | null {
  const index = sorted.findIndex((episode) => episode.id === currentId);
  if (index === -1 || index === sorted.length - 1) return null;
  return sorted[index + 1];
}

/**
 * A series' full playable episode list (Jellyfin only, no Sonarr merge) -
 * the source for the player's previous/next buttons and jump menu.
 * `seriesId: null` disables the query (movies, or before `usePlaybackInfo`
 * has resolved the playing item's Type/SeriesId).
 */
export function useSeriesEpisodeList(seriesId: string | null, userId: string) {
  return useQuery({
    queryKey: queryKeys.seriesEpisodeList(seriesId ?? ''),
    queryFn: async (): Promise<EpisodeNavItem[]> => {
      const result = await getItems(userId, {
        parentId: seriesId ?? '',
        includeItemTypes: 'Episode',
        recursive: true,
        // A sort hint only - `sortEpisodes` below re-sorts client-side
        // regardless, so correctness never depends on the server honoring
        // this multi-key `SortBy` (Jellyfin's own comma-separated form).
        sortBy: 'ParentIndexNumber,IndexNumber',
        sortOrder: 'Ascending',
        // Deliberately NOT passing `fields`: `ParentIndexNumber`/`IndexNumber`
        // are base Episode DTO properties Jellyfin always returns, not ones
        // gated behind the optional `Fields` enum whitelist (unlike
        // `MediaStreams`/`ProviderIds`) - putting them in `Fields` risks the
        // server's enum model-binder silently dropping (or, less likely,
        // rejecting) an unrecognized value for no benefit. Falling through to
        // `getItems`'s own default (`'ProviderIds,MediaStreams'`) reuses a
        // value every other call site in this codebase already relies on.
      });
      return sortEpisodes(
        result.Items.map((item) => ({
          id: item.Id,
          seasonNumber: item.ParentIndexNumber ?? 0,
          episodeNumber: item.IndexNumber ?? 0,
          title: item.Name,
          imageTag: item.ImageTags?.Primary ?? null,
        })),
      );
    },
    enabled: Boolean(seriesId && userId),
    // The episode list for a series does not change mid-session; refetching
    // it every time the user pages between siblings (the exact action this
    // hook exists to support) would be wasted network traffic for no gain.
    staleTime: 5 * 60 * 1000,
  });
}
