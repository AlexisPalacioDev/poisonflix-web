import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRatings, setTrackRating, type RatingValue } from '../api/music';
import type { MusicRatingsResponse, MusicResultItem } from '../api/schemas/music';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Thumbs up / down, YouTube Music style. The vote lives in the worker keyed by
// videoId — see `setTrackRating` — so it covers tracks that were never
// downloaded, which is exactly where a thumb-down matters most.
//
// Casting a vote invalidates the feeds: a rejected track has to disappear from
// the recommendations that suggested it, and a like has to start showing up in
// the radios it now seeds. Seeing neither happen would tell the user the button
// did nothing — which, for the thumb-up, used to be literally true.

/** What the worker needs stored alongside a vote so "Tus me gusta" can render it. */
export interface RatingMeta {
  title?: string | null;
  artist?: string | null;
  thumbnailUrl?: string | null;
}

export interface Ratings {
  ratingFor: (videoId: string) => RatingValue;
  rate: (videoId: string, rating: RatingValue, meta?: RatingMeta) => void;
  /** The thumbed-up tracks, newest first. Empty until something is liked. */
  liked: MusicResultItem[];
  isRating: boolean;
}

export function useRatings(): Ratings {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.musicRatings(),
    queryFn: getRatings,
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: ({
      videoId,
      rating,
      meta,
    }: {
      videoId: string;
      rating: RatingValue;
      meta?: RatingMeta;
    }) => setTrackRating(videoId, rating, meta),
    // Optimistic: the thumb must fill the instant it is pressed. A vote that
    // waits on a round-trip feels broken on a control pressed this casually.
    onMutate: async ({ videoId, rating, meta }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.musicRatings() });
      const previous = queryClient.getQueryData<MusicRatingsResponse>(
        queryKeys.musicRatings(),
      );
      queryClient.setQueryData<MusicRatingsResponse>(queryKeys.musicRatings(), (old) => {
        const ratings = { ...(old?.ratings ?? {}) };
        if (rating === 0) delete ratings[videoId];
        else ratings[videoId] = rating;
        // Keep `liked` in step too, or the list the user is looking at would
        // not move until the refetch lands. MusicResultItem is a union — only
        // the `song` arm carries a videoId — so narrow before comparing.
        const rest = (old?.liked ?? []).filter(
          (t) => !('videoId' in t) || t.videoId !== videoId,
        );
        const liked =
          rating === 1
            ? [
                {
                  type: 'song' as const,
                  videoId,
                  title: meta?.title ?? videoId,
                  artist: meta?.artist ?? null,
                  artists: meta?.artist ? [meta.artist] : [],
                  album: null,
                  durationSeconds: null,
                  thumbnailUrl: meta?.thumbnailUrl ?? null,
                  source: 'ytmusic' as const,
                } as MusicResultItem,
                ...rest,
              ]
            : rest;
        return { ...(old ?? { ratings: {}, liked: [] }), ratings, liked };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.musicRatings(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.musicRatings() });
      // The feeds are built server-side with disliked tracks already removed,
      // so they have to be refetched for the rejection to actually show.
      queryClient.invalidateQueries({ queryKey: ['music', 'seedRadio'] });
      queryClient.invalidateQueries({ queryKey: ['music', 'recommendations'] });
    },
  });

  const ratings = query.data?.ratings ?? {};

  return {
    ratingFor: (videoId) => ((ratings[videoId] ?? 0) as RatingValue),
    rate: (videoId, rating, meta) => mutation.mutate({ videoId, rating, meta }),
    liked: query.data?.liked ?? [],
    isRating: mutation.isPending,
  };
}
