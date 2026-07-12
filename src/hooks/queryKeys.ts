// Namespaced tuple query-key factory (design.md §4.1). Session identity is
// implicit (same-origin token); keys don't include the token. Logout clears
// the whole cache via `queryClient.clear()` (Slice 3).

export const queryKeys = {
  library: (userId: string, params?: unknown) => ['jellyfin', 'library', userId, params] as const,
  trending: () => ['jellyseerr', 'trending'] as const,
  search: (debouncedQuery: string) => ['jellyseerr', 'search', debouncedQuery] as const,
  item: (itemId: string) => ['jellyfin', 'item', itemId] as const,
  playbackInfo: (itemId: string) => ['jellyfin', 'playbackInfo', itemId] as const,
};
