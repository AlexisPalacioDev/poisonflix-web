import { useQuery } from '@tanstack/react-query';
import { cleanReleaseTitle, getAnilistCover } from '../api/anilist';
import { ADULT_BROWSE_QUERY, ADULT_INDEXER_IDS, searchAdult } from '../api/prowlarr';
import type { ProwlarrRelease } from '../api/schemas/prowlarr';
import { queryKeys } from './queryKeys';
import { useAdultUnlocked } from './useAdultUnlocked';
import { useAuth } from './useAuth';
import { useDebouncedValue } from './useDebouncedValue';

// Home's +18 discover row (projector-feature-map.md §3 "+18 / adult
// section"), ported from `MediaRepositoryImpl.kt`'s `adultRow`: a Prowlarr
// manual search over the adult indexers, collapsed to one card per show
// (best-seeded release wins - per-episode releases would otherwise flood the
// row with duplicates of the same title), then AniList-enriched with a cover
// per show (TMDB/Jellyfin have no hentai artwork at all).

const ADULT_ROW_LIMIT = 40;
const MIN_ADULT_SEARCH_LENGTH = 2;

export interface AdultRowItem {
  title: string;
  posterUrl: string | null;
  /** Prowlarr release identity needed to grab it later ("Pedir" for +18). */
  prowlarrGuid: string | null;
  prowlarrIndexerId: number | null;
}

/**
 * `ProwlarrReleaseSchema` (`api/schemas/prowlarr.ts`) is `.passthrough()`'d
 * and only models `indexer` (the display name) - it deliberately does NOT
 * model the numeric `indexerId` Prowlarr's real payload also carries, since
 * editing that shared schema is out of scope for this change. Passthrough
 * still keeps `indexerId` on the parsed object at runtime; this narrows it
 * defensively from the schema's `unknown` passthrough field.
 */
function releaseIndexerId(release: ProwlarrRelease): number | null {
  const raw = (release as unknown as { indexerId?: unknown }).indexerId;
  return typeof raw === 'number' ? raw : null;
}

interface CollapsedShow {
  title: string;
  guid: string | null;
  indexerId: number | null;
}

/**
 * Collapse per-episode Prowlarr releases to one entry per show, exported
 * separately so the merge is unit-testable without mocking `searchAdult`/
 * `getAnilistCover` (mirrors `useGenreRow.ts`'s `mergeGenreRow` pattern).
 * Best-seeded release wins per show - same tie-break as
 * `MediaRepositoryImpl.kt`'s `adultRow`.
 */
export function collapseAdultReleases(releases: ProwlarrRelease[], limit = ADULT_ROW_LIMIT): CollapsedShow[] {
  const byShow = new Map<string, CollapsedShow & { seeders: number }>();

  const sorted = [...releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  for (const release of sorted) {
    const title = cleanReleaseTitle(release.title);
    if (!title) continue;

    const key = title.toLowerCase();
    if (byShow.has(key)) continue;

    byShow.set(key, {
      title,
      guid: release.guid ?? null,
      indexerId: releaseIndexerId(release),
      seeders: release.seeders ?? 0,
    });
  }

  return Array.from(byShow.values())
    .slice(0, limit)
    .map(({ title, guid, indexerId }) => ({ title, guid, indexerId }));
}

async function fetchAdultShows(query: string, indexerIds: number[]): Promise<AdultRowItem[]> {
  let releases: ProwlarrRelease[];
  try {
    releases = await searchAdult(query, indexerIds);
  } catch {
    // Prowlarr 401s without an API key configured in this dev env
    // (`lib/http/client.ts` surfaces that as a plain `ApiError` for
    // non-session backends, see its 401 branch) - degrade to an empty row
    // instead of failing the whole query, same row-isolation spirit as
    // `useGenreRow`'s discover half.
    return [];
  }

  const shows = collapseAdultReleases(releases);

  // AniList cover per show, looked up concurrently. Best-effort: a failed
  // lookup just leaves that card posterless, it never fails the row (mirrors
  // `MediaRepositoryImpl.kt`'s `enrichPosters`).
  return Promise.all(
    shows.map(async (show) => ({
      title: show.title,
      prowlarrGuid: show.guid,
      prowlarrIndexerId: show.indexerId,
      posterUrl: await getAnilistCover(show.title).catch(() => null),
    })),
  );
}

/** Home's fixed +18 row - always the same browse query (`ArrConfig.kt`'s `ADULT_BROWSE_QUERY`). */
export function useAdultRow() {
  const unlocked = useAdultUnlocked();
  const { session } = useAuth();

  return useQuery({
    queryKey: queryKeys.adultRow(),
    queryFn: () => fetchAdultShows(ADULT_BROWSE_QUERY, ADULT_INDEXER_IDS),
    enabled: unlocked && Boolean(session),
    // Same cadence as useGenreRow/useLibraryRow (design.md §4.2).
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

/**
 * `/search_adult`'s free-text search (walkthrough §5/§7's adult search
 * mode). `queryKeys.ts` only has a fixed, no-args `adultRow()` key for
 * Home's row - out of scope to extend it for a per-query key, so this uses
 * an inline tuple key here instead, same tuple-key convention, just not
 * centralized in the factory.
 */
export function useAdultSearch(rawQuery: string) {
  const unlocked = useAdultUnlocked();
  const debounced = useDebouncedValue(rawQuery, 350);
  const trimmed = debounced.trim();
  const enabled = unlocked && trimmed.length >= MIN_ADULT_SEARCH_LENGTH;

  const query = useQuery({
    queryKey: ['prowlarr', 'adultSearch', trimmed] as const,
    queryFn: () => fetchAdultShows(trimmed, ADULT_INDEXER_IDS),
    enabled,
    staleTime: 30_000,
  });

  return {
    debouncedQuery: trimmed,
    enabled,
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError,
    items: query.data ?? [],
    refetch: query.refetch,
  };
}
