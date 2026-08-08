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
  // Música: YouTube Music search (via the worker), the user's Jellyfin Audio
  // library, and per-download job polling. The search key is scoped by `source`
  // too so toggling YT Music / YouTube caches each surface independently.
  musicSearch: (debouncedQuery: string, source: string) =>
    ['music', 'search', debouncedQuery, source] as const,
  musicLibrary: (userId: string) => ['music', 'library', userId] as const,
  // Just the count of Audio items, for surfaces that print a number and nothing
  // else (the /musica entry card). Nested *under* `musicLibrary` on purpose:
  // react-query matches invalidations by key prefix, so every existing
  // `invalidateQueries(musicLibrary(userId))` after a download or a delete
  // refreshes the count too, with no extra call site to remember.
  musicLibraryCount: (userId: string) => ['music', 'library', userId, 'count'] as const,
  musicJob: (jobId: string) => ['music', 'job', jobId] as const,
  // Música browse (Slice 3): album/artist grids (keyed by user) and the two
  // detail views — an album's track list and an artist's albums (keyed by id).
  musicAlbums: (userId: string) => ['music', 'albums', userId] as const,
  musicArtists: (userId: string) => ['music', 'artists', userId] as const,
  musicAlbum: (albumId: string) => ['music', 'album', albumId] as const,
  musicArtist: (artistId: string) => ['music', 'artist', artistId] as const,
  // Track detail "Más de {artista}" section: other songs by the same artist
  // (keyed by artist id). Its own key so it never collides with `musicArtist`,
  // which caches the artist's *albums* under a different shape.
  musicArtistSongs: (artistId: string) => ['music', 'artistSongs', artistId] as const,
  // Música track detail (/musica/track/:id): a single `Audio` item fetched with
  // its linkable ids (ArtistItems/AlbumId) + Genres for the detail screen.
  musicTrack: (trackId: string) => ['music', 'track', trackId] as const,
  // Música (Spotify redesign): the "Recomendados para ti" feed (keyed by seed,
  // '' for the general mix), a playlist-download batch's progress (keyed by
  // batchId), the Géneros chip list (keyed by user), and the songs under one
  // selected genre (keyed by user + genre).
  musicRecommendations: (seed: string) => ['music', 'recommendations', seed] as const,
  // Personalised feed: this user's played-audio history, and the radio built
  // from one of its tracks. Both keyed by user so switching accounts can never
  // serve someone else's taste from cache.
  musicHistory: (userId: string, sortBy: string) =>
    ['music', 'history', userId, sortBy] as const,
  musicRatings: () => ['music', 'ratings'] as const,
  musicLibrarySample: (userId: string) => ['music', 'librarySample', userId] as const,
  musicSeedRadio: (userId: string, seedItemId: string) =>
    ['music', 'seedRadio', userId, seedItemId] as const,
  // Radio seeded by a streaming-preview videoId rather than a Jellyfin item id
  // (mobile-music-overhaul: feed seeded from real plays). Kept as its own key
  // so a preview-seeded radio never collides in cache with an itemId-seeded
  // one — the two can carry the same string value for unrelated tracks.
  musicSeedRadioByVideo: (userId: string, videoId: string) =>
    ['music', 'seedRadioByVideo', userId, videoId] as const,
  // Pure-mode radios (mobile-music-overhaul: fix-seeded-rows) — seed-only,
  // no user-global sources mixed in. Kept as their own keys, never sharing a
  // cache entry with the default-mode radios above: the two are genuinely
  // different payloads for the same seed, and one feeds "Porque escuchaste
  // X" rows while the other feeds "Mix para vos".
  musicSeedRadioPure: (userId: string, seedItemId: string) =>
    ['music', 'seedRadioPure', userId, seedItemId] as const,
  musicSeedRadioByVideoPure: (userId: string, videoId: string) =>
    ['music', 'seedRadioByVideoPure', userId, videoId] as const,
  // Usage monitor. `serverUsage` is admin-wide; `myMusicStats` is per user.
  serverUsage: (days: number) => ['usage', 'server', days] as const,
  activeSessions: () => ['usage', 'sessions'] as const,
  myMusicStats: (userId: string) => ['usage', 'me', userId] as const,
  // Preview listens, tallied by the worker (no Jellyfin item exists for them).
  previewPlays: (userId: string) => ['usage', 'me', userId, 'previews'] as const,
  musicPlaylistBatch: (batchId: string) => ['music', 'playlist', batchId] as const,
  musicGenres: (userId: string) => ['music', 'genres', userId] as const,
  musicGenreSongs: (userId: string, genre: string) =>
    ['music', 'genre', userId, genre] as const,
  // User-created Jellyfin Playlists (Playlists feature): the user's list of
  // playlists (keyed by user) and one playlist's tracks (keyed by playlist id).
  userPlaylists: (userId: string) => ['jellyfin', 'userPlaylists', userId] as const,
  userPlaylist: (playlistId: string) => ['jellyfin', 'userPlaylist', playlistId] as const,
  // Jam (collaborative listening): the caller's own jams + pending invites
  // (each entry carries `myRole`, which doubles as how the screen learns its
  // own Jellyseerr user id — see JamScreen's module doc comment), and the
  // directory of users the owner can invite. Neither is scoped by userId:
  // both are already scoped to the caller by the BFF's own session cookie.
  jamList: () => ['jam', 'list'] as const,
  jamDirectory: () => ['jam', 'directory'] as const,
  // Player episode prev/next/jump navigation (owner request): a series' full
  // playable episode list, keyed by series id so paging between siblings
  // reuses the same cache entry instead of refetching per episode.
  seriesEpisodeList: (seriesId: string) => ['player', 'seriesEpisodeList', seriesId] as const,
};
