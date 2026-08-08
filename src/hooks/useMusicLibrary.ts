import { useQuery } from '@tanstack/react-query';
import { getItems } from '../api/jellyfin';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// "Tu música" — the user's Jellyfin Audio library, newest first. Reads straight
// through the existing Jellyfin proxy with the user's own token (same model as
// the video library rows); the worker only writes files + triggers scans.
//
// Two hooks, because the two callers want opposite things:
//
//   useMusicLibrary()      -> every song, with the fields the cards need.
//                             `/musica/descargas` renders these.
//   useMusicLibraryCount() -> one number and no items at all.
//                             `/musica` prints "N canciones en el servidor".
//
// They used to be the same query. That made the landing page — the first screen
// of the section — pay for 500 fully-hydrated Audio items (MediaStreams,
// ArtistItems, Genres) to render a single integer it read off
// `TotalRecordCount`.

const AUDIO_FILTER = {
  includeItemTypes: 'Audio',
  recursive: true,
  sortBy: 'DateCreated',
  sortOrder: 'Descending',
} as const;

// `ArtistItems`/`Genres` are only returned when asked for; `AlbumId` and
// `AlbumPrimaryImageTag` ride along with Audio items. Needed so the cover-art
// fallback chain (resolveCoverUrl) can reach the album/artist images.
const LIBRARY_FIELDS = 'ProviderIds,MediaStreams,Genres,ArtistItems';

// One request covers every library this app will realistically see; the loop
// exists so the page keeps its promise ("todo lo que descargaste") when it
// doesn't, instead of silently rendering the first slice and captioning it with
// the server's larger total.
const PAGE_SIZE = 500;
// A ceiling, not a target: it only bounds a server that keeps reporting a total
// it never delivers. 20k songs is far past anything this library holds.
const MAX_PAGES = 40;

async function fetchWholeLibrary(userId: string): Promise<JellyfinItem[]> {
  const items: JellyfinItem[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await getItems(userId, {
      ...AUDIO_FILTER,
      fields: LIBRARY_FIELDS,
      limit: PAGE_SIZE,
      startIndex: page * PAGE_SIZE,
    });

    const batch = result.Items ?? [];
    items.push(...batch);

    // A short page is the end of the list, whatever the server says its total
    // is — and it has to be the primary stop condition, because the response
    // schema defaults `TotalRecordCount` to 0 when it is absent. Ending the
    // walk on the count alone would then stop after page one (`500 >= 0`) and
    // quietly hand back a truncated library.
    if (batch.length < PAGE_SIZE) break;

    const total = result.TotalRecordCount;
    if (total > 0 && items.length >= total) break;
  }

  return items;
}

export function useMusicLibrary() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicLibrary(userId),
    queryFn: () => fetchWholeLibrary(userId),
    enabled: Boolean(session),
    staleTime: 10_000,
  });

  const items: JellyfinItem[] = query.data ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/**
 * How many songs are on the server, without downloading any of them.
 * `Limit=0` returns an empty `Items` with `TotalRecordCount` filled in, and no
 * `Fields` are requested, so the response is a few dozen bytes.
 */
export function useMusicLibraryCount() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  const query = useQuery({
    queryKey: queryKeys.musicLibraryCount(userId),
    queryFn: () => getItems(userId, { ...AUDIO_FILTER, fields: '', limit: 0 }),
    enabled: Boolean(session),
    staleTime: 10_000,
  });

  return {
    total: query.data?.TotalRecordCount ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
