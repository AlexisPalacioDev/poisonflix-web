import { useQuery } from '@tanstack/react-query';
import { getCurrentUser } from '../../api/jellyfin';

// Who the cast URL's token belongs to.
//
// Every item/playback endpoint Jellyfin exposes is scoped to a user id, and
// the cast URL carries only a token. Asking the server (`GET /Users/Me`) is
// the alternative to putting a second value in the URL that would have to
// agree with the first one forever - a token already identifies its user, so
// carrying the id alongside it only creates a way for the two to disagree.
//
// The key is local to this feature rather than in `hooks/queryKeys.ts`: it is
// keyed by a credential that arrived in a URL, which has no business in the
// app-wide key registry the authenticated screens share.
export function useCastViewer(token: string) {
  return useQuery({
    queryKey: ['cast', 'viewer', token],
    queryFn: () => getCurrentUser({ authToken: token }),
    enabled: token.trim() !== '',
    // A token's owner cannot change while the page is open, and this runs on a
    // television nobody is going to refocus - re-asking would only add a way
    // to fail mid-playback.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A rejected token is a final answer, not a blip: retrying would delay the
    // message that tells the user to send the video again.
    retry: false,
  });
}
