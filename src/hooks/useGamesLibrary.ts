import { useQuery } from '@tanstack/react-query';
import { getGamesLibrary } from '../api/games';
import type { Game } from '../api/schemas/games';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// The ROM library, read once and reused. Both Juegos screens need it: the
// grid lists it, and the player looks up which console the game it was handed
// belongs to — `/juegos/play/:id` carries only the id, so a deep link has to
// be able to resolve the rest rather than rely on router state that a reload
// throws away.

// A stable empty array: `query.data ?? []` would hand a new reference to every
// `useMemo` downstream on each render, which is exactly what those memos exist
// to avoid.
const NO_GAMES: Game[] = [];

export function useGamesLibrary() {
  const { session } = useAuth();

  const query = useQuery({
    queryKey: queryKeys.gamesLibrary(),
    queryFn: getGamesLibrary,
    enabled: Boolean(session),
    // A directory listing changes when someone drops a file on the server, not
    // while the user is scrolling it.
    staleTime: 60_000,
  });

  return {
    games: query.data ?? NO_GAMES,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
