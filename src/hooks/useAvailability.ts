import { useQuery } from '@tanstack/react-query';
import { searchReleases } from '../api/prowlarr';
import { summarizeAvailability, type AvailabilitySummary } from '../lib/domain/availability';
import { queryKeys } from './queryKeys';

// Pre-download availability preview: searches Prowlarr for the title and folds
// the raw releases into a language/seeder summary. Kept off the critical detail
// render (its own query, own loading state) so a slow indexer search never
// blocks the poster/overview/"Pedir" button from showing.

export function useAvailability(title: string | undefined, tmdbId?: number | null) {
  const query = (title ?? '').trim();
  return useQuery<AvailabilitySummary>({
    queryKey: queryKeys.availability(query, tmdbId ?? null),
    queryFn: async () => {
      const releases = await searchReleases(query);
      // Coerce the passthrough Prowlarr rows to the minimal candidate shape;
      // Zod's `.passthrough()` widens declared fields to look optional, so map
      // them explicitly rather than leaning on structural assignability.
      const candidates = releases.map((r) => ({
        title: r.title ?? '',
        seeders: r.seeders ?? 0,
        tmdbId: r.tmdbId ?? 0,
      }));
      return summarizeAvailability(candidates, { tmdbId });
    },
    enabled: query.length > 0,
    // A Prowlarr search hits every indexer — expensive and slow-changing.
    // Cache generously so revisiting a title doesn't re-hammer the indexers.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
