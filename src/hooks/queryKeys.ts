// Namespaced tuple query-key factory (design.md §4.1). Session identity is
// implicit (same-origin token); keys don't include the token. Logout clears
// the whole cache via `queryClient.clear()` (Slice 3).

export const queryKeys = {
  library: (userId: string, params?: unknown) => ['jellyfin', 'library', userId, params] as const,
  trending: () => ['jellyseerr', 'trending'] as const,
  // One key per genre row (Home's 10 mixed genre rows, projector-feature-map.md
  // §3) - each row is its own independent useQuery (ADR-3, row isolation), so
  // scoping the key by both userId and category id keeps rows from colliding
  // across users or genres in the cache.
  genreRow: (categoryId: string, userId: string) => ['genreRow', categoryId, userId] as const,
  search: (debouncedQuery: string) => ['jellyseerr', 'search', debouncedQuery] as const,
  item: (itemId: string) => ['jellyfin', 'item', itemId] as const,
  // Player track menus parse the item's `MediaStreams` into a
  // `MediaStreamTrack[]`. This MUST NOT share `item`'s key: that key caches the
  // raw `JellyfinItem` object (Detail's `useLibraryItem`), and React Query
  // serves whichever shape populated the entry last. A movie opened in Detail
  // (raw object cached, 60s staleTime) then played would hand the player a
  // non-array `data`, crashing `audioTracksOf` with `.filter is not a function`.
  itemMediaStreams: (itemId: string) => ['jellyfin', 'item-mediastreams', itemId] as const,
  detail: (mediaType: string, tmdbId: string) => ['jellyseerr', 'detail', mediaType, tmdbId] as const,
  playbackInfo: (itemId: string) => ['jellyfin', 'playbackInfo', itemId] as const,
  availability: (query: string, tmdbId: number | null) =>
    ['prowlarr', 'availability', query, tmdbId] as const,
  downloadProgress: () => ['arr', 'downloadProgress'] as const,
  // Continue Watching row (Jellyfin resume feed, projector-feature-map.md §3).
  resumeRow: (userId: string) => ['jellyfin', 'resume', userId] as const,
  // Active Jellyseerr requests — Downloads screen + Home "En camino" row.
  requests: (filter: string) => ['jellyseerr', 'requests', filter] as const,
  // TV series episode list (Detail two-pane), merged from Jellyfin (playable
  // truth) + Sonarr (full list + queue %). Keyed by the series' TMDB id.
  episodes: (tmdbId: string) => ['detail', 'episodes', tmdbId] as const,
  // +18 adult row (Prowlarr discover) and AniList cover/info enrichment.
  adultRow: () => ['prowlarr', 'adult'] as const,
  adultInfo: (title: string) => ['anilist', 'info', title] as const,
  // Admin screen: invite codes + Jellyfin users list.
  invites: () => ['bff', 'invites'] as const,
  adminUsers: () => ['bff', 'adminUsers'] as const,
  adminStorage: () => ['bff', 'adminStorage'] as const,
};
