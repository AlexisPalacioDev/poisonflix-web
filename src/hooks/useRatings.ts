import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRatings, setTrackRating, type RatingValue } from '../api/music';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Thumbs up / down, YouTube Music style. The vote lives in the worker keyed by
// videoId — see `setTrackRating` — so it covers tracks that were never
// downloaded, which is exactly where a thumb-down matters most.
//
// Casting a vote invalidates the feeds: a rejected track has to disappear from
// the recommendations that suggested it, and seeing it linger would tell the
// user the button did nothing.

export interface Ratings {
  ratingFor: (videoId: string) => RatingValue;
  rate: (videoId: string, rating: RatingValue) => void;
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
    mutationFn: ({ videoId, rating }: { videoId: string; rating: RatingValue }) =>
      setTrackRating(videoId, rating),
    // Optimistic: the thumb must fill the instant it is pressed. A vote that
    // waits on a round-trip feels broken on a control pressed this casually.
    onMutate: async ({ videoId, rating }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.musicRatings() });
      const previous = queryClient.getQueryData<Record<string, number>>(
        queryKeys.musicRatings(),
      );
      queryClient.setQueryData<Record<string, number>>(queryKeys.musicRatings(), (old) => {
        const next = { ...(old ?? {}) };
        if (rating === 0) delete next[videoId];
        else next[videoId] = rating;
        return next;
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

  const ratings = query.data ?? {};

  return {
    ratingFor: (videoId) => ((ratings[videoId] ?? 0) as RatingValue),
    rate: (videoId, rating) => mutation.mutate({ videoId, rating }),
    isRating: mutation.isPending,
  };
}
