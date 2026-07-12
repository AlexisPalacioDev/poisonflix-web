# PoisonFlix Projector — Exhaustive Feature/Component Map

Authoritative reference for porting EVERY feature of the Android TV projector
app (`com.hy300.poisonflix`, Compose-for-TV) into the web app. Source tree read
in full: `/home/alexis/Documentos/poisonflix/app/src/main/java/com/hy300/poisonflix/`.

Stack (projector): Kotlin, Jetpack Compose + `androidx.tv.material3`, Media3
ExoPlayer, Retrofit + kotlinx.serialization, manual DI (no Hilt/Dagger),
`AndroidViewModel` + `StateFlow`. Backends: Jellyfin, Jellyseerr, Prowlarr,
Radarr, Sonarr, AniList.

All citations are `path:line` relative to the projector source root above.

---

## 1. Navigation flow (NavHost / route graph)

Route constants: `ui/navigation/PoisonFlixDestinations.kt`.
Graph + wiring: `ui/navigation/PoisonFlixNavHost.kt`.
Entry: `MainActivity.kt:19-34` → `PoisonFlixTheme` → `PoisonFlixNavHost()`.

Start destination is decided at runtime by `SessionBootstrapViewModel`
(`ui/onboarding/SessionBootstrapViewModel.kt`), NOT a hard-coded route:

```
MainActivity
  └─ PoisonFlixNavHost  (PoisonFlixNavHost.kt:44-137)
       │
       │  bootstrapViewModel.destination  (StateFlow<BootstrapDestination>)
       │
       ├─ Loading   → PoisonSplash()  (branded pulsing-mascot splash; no NavHost yet)  [NavHost.kt:52]
       │
       └─ resolved (Onboarding | Home) → NavHost(startDestination = …)  [NavHost.kt:54-61]
              startDestination = HOME  if a persisted session restored
              startDestination = ONBOARDING otherwise
              (Onboarding NEVER renders when a valid session is restored — avoids flash)

       Routes registered in the NavHost:
       ┌──────────────────────────────────────────────────────────────────────┐
       │ "onboarding"  → OnboardingScreen                                       │
       │      onLoginSuccess → navigate("home"){ popUpTo("onboarding"){incl} }  │  [NavHost.kt:62-70]
       │                                                                        │
       │ "home"        → HomeScreen                        (START when session) │  [NavHost.kt:71-83]
       │      onNavigateToSearch        → navigate("search")                    │
       │      onNavigateToAdultSearch   → navigate("search_adult")              │
       │      onNavigateToDownloads     → navigate("downloads")                 │
       │      onNavigateToDetail(item)  → navigate("detail/{mediaRef}")         │
       │      onNavigateToPlayer(jfId)  → navigate("player/{jfId}")             │
       │                                                                        │
       │ "search"          → SearchScreen(adult=false)                          │  [NavHost.kt:84-90]
       │      onNavigateToPlayer(jfId)  → navigate("player/{jfId}")             │
       │                                                                        │
       │ "search_adult"    → SearchScreen(adult=true)   (+18 Prowlarr search)   │  [NavHost.kt:91-98]
       │                                                                        │
       │ "downloads"       → DownloadsScreen                                    │  [NavHost.kt:99-105]
       │      onItemClick(item) → navigate("detail/{mediaRef}")                 │
       │                                                                        │
       │ "detail/{mediaRef}"  → DetailScreen   (mediaRef = String nav arg)      │  [NavHost.kt:106-122]
       │      onNavigateToPlayer(jfId)  → navigate("player/{jfId}")             │
       │      onNavigateBack            → popBackStack()                        │
       │                                                                        │
       │ "player/{jellyfinItemId}" → PlayerScreen                              │  [NavHost.kt:123-133]
       └──────────────────────────────────────────────────────────────────────┘
```

Route builders (`PoisonFlixDestinations.kt:29-32`):
- `detail(mediaRef) = "detail/$mediaRef"`
- `player(jellyfinItemId) = "player/$jellyfinItemId"`

Back-navigation:
- Detail → `popBackStack()` on explicit back and auto-back after a successful
  delete/cancel (`DetailScreen.kt:119-127`, driven by `state.isDeleted`/`state.isCancelled`).
- Player track menus intercept BACK to close the menu (return to player), not
  pop the player (`TrackMenu.kt:162` `BackHandler(onBack = onDismiss)`).
- ConfirmOverlay/PIN overlay intercept BACK to dismiss the overlay
  (`ConfirmOverlay.kt:56`, `AdultPinOverlay.kt:75-82`).
- Session invalidation (either backend 401) routes Home → Onboarding
  (`SessionBootstrapViewModel.kt:58-74`).

**mediaRef opaque nav-id scheme** (`domain/model/MediaItem.kt:42-47`, parsed in
`domain/model/MediaRef.kt:27-54`):
- `jf:<jellyfinItemId>` — library item.
- `tmdb:<mediaType>:<tmdbId>` — TMDB/Jellyseerr item.
- `adult:<indexerId>:<b64guid>:<b64title>` — Prowlarr +18 release (guid/title
  URL-safe-Base64 encoded, `MediaRef.kt:59-63`).

---

## 2. Every screen

### Onboarding (`ui/onboarding/OnboardingScreen.kt`, VM `OnboardingViewModel.kt`)
- Purpose: dual-backend login (Jellyfin + Jellyseerr), both-or-nothing.
- Layout: two-panel Row. LEFT brand panel — `PoisonMascot` (time-of-day),
  "PoisonFlix" title, tagline "Tu Netflix propio, en un solo lugar. Busca, pide
  y mira todo desde aquí." (`OnboardingScreen.kt:72-89`). RIGHT form card
  (480dp, Surface, rounded) with 4 `LabeledField`s: URL de Jellyfin, URL de
  Jellyseerr, Usuario, Contraseña (password) + error text + "Conectar" button.
- Prefilled defaults (`OnboardingViewModel.kt:26-27`): `http://192.168.1.61:8096`,
  `http://192.168.1.61:5055`.
- Entry: NavHost start (no session). Exit: `onLoginSuccess` → Home (pop self).

### Home (`ui/home/HomeScreen.kt`, VM `HomeViewModel.kt`) — full detail in §3.

### Search (`ui/search/SearchScreen.kt`, VM `SearchViewModel.kt`) — full detail in §5/§7. Two modes: normal + adult.

### Detail (`ui/detail/DetailScreen.kt`, VM `DetailViewModel.kt`) — full detail in §7.

### Player (`ui/player/PlayerScreen.kt`, VM `PlayerViewModel.kt`) — full detail in §8.

### Downloads (`ui/downloads/DownloadsScreen.kt`, VM `DownloadsViewModel.kt`) — full detail in §9.

### Splash (`ui/components/Brand.kt:83 PoisonSplash`)
- Full-screen branded loading shown while `SessionBootstrapViewModel` resolves.
  Pulsing time-of-day mascot + "PoisonFlix". Not a route — a NavHost state branch.

---

## 3. HOME — every row/section, in order, with data source

`HomeScreen.kt` renders a top bar + a `TvLazyColumn` of rows. `HomeUiState`
(`HomeViewModel.kt:37-49`).

### Top bar (`HomeScreen.kt:152-176`)
- `PoisonBrand` (mascot + wordmark) on the left.
- Right group (focusGroup): `LanguageChip` (ES⇄EN TMDB metadata toggle,
  `HomeScreen.kt:354-379`, calls `AppSettings.toggleLanguage()`), Search icon
  button → `onNavigateToSearch`, Download icon button → `onNavigateToDownloads`.
- UP-key from the first content row is intercepted at the screen root and
  redirected to the Search icon (geometric focus can't reach the top bar),
  `HomeScreen.kt:143-150`.

### Rows in exact render order (`HomeScreen.kt:178-247`)

1. **Continuar viendo** (`ContinueWatchingRow`, `HomeScreen.kt:183-193, 381-420`)
   - Shown only if `state.continueWatching` non-empty. Accent eyebrow.
   - Data: `MediaRepository.getContinueWatchingRow(limit=20)` →
     `JellyfinApi.getResumeItems` (`Users/{id}/Items/Resume`), polled every 20s
     while Home is resumed (`HomeViewModel.kt:172-184, 229`).
   - Cards show `resumePercent` progress bar (bottom bar only, `dimUnwatched=false`).
   - Click plays directly via `jellyfinItemId` → `onNavigateToPlayer`.

2. **En camino** (downloading, `DownloadingRow`, `HomeScreen.kt:194-204, 422-471`)
   - Shown only if `state.downloadingItems` non-empty. Label "EN CAMINO".
   - Data: `RequestRepository.getDownloads()` filtered to `statusLabel != "Disponible"`,
     enriched with real % from `DownloadProgressProvider.progressByTmdbId()`,
     polled every 15s (`HomeViewModel.kt:154-171, 228`).
   - Card badge = uppercased `statusLabel` (Pendiente/Descargando/…), progress bar.
   - Click → Detail (via `DownloadItem.toMediaItem().toMediaRef()`).

3. **En tu librería** (`MediaRow`, `HomeScreen.kt:205-215`)
   - Data: `MediaRepository.getLibraryRow(limit=20)` → all non-adult Jellyfin
     libraries' Movie/Series sorted by DateCreated desc
     (`MediaRepositoryImpl.kt:44-46, 196-207`). Loaded once in `init`.

4. **Tendencias / Descubrir** (`MediaRow`, `HomeScreen.kt:216-223`)
   - Data: `MediaRepository.getDiscoverRow(limit=20)` →
     `JellyseerrApi.discoverTrending(page=1)` filtered to movie/tv
     (`MediaRepositoryImpl.kt:48-53`). Re-fetched on language toggle
     (`HomeViewModel.kt:78-83`).
   - TMDB-only items get a "PEDIR" badge (`HomeScreen.kt:520-534`).

5. **10 genre/category rows** (`categoryRows`, `HomeScreen.kt:224-231`) — see below.

6. **+18 section** (`HomeScreen.kt:232-246`) — see §3 adult subsection.

### EXACT category list (`domain/model/Category.kt:29-45`, `CategoryCatalog.NORMAL`)

Each row is a MIXED row: `getCategoryRow(category)` in `MediaRepositoryImpl.kt:60-104`
concatenates (a) library items of that genre from every non-adult Jellyfin
library (`JellyfinApi.getItems` with `Genres=<jellyfinGenre>`, per-library
scoped, dedup by tmdbId) + (b) TMDB discover for that genre id via
`JellyseerrApi.discoverMoviesByGenre(genreId)`, dropping adults and titles
already owned. Each row loads independently (own coroutine, own RowState).

| Order | id | Label (UI) | jellyfinGenre (es-MX) | tmdbMovieGenreId |
|---|---|---|---|---|
| 1 | action | Acción | Acción | 28 |
| 2 | comedy | Comedia | Comedia | 35 |
| 3 | horror | Terror | Terror | 27 |
| 4 | scifi | Ciencia ficción | Ciencia ficción | 878 |
| 5 | drama | Drama | Drama | 18 |
| 6 | animation | Animación | Animación | 16 |
| 7 | crime | Crimen | Crimen | 80 |
| 8 | romance | Romance | Romance | 10749 |
| 9 | adventure | Aventura | Aventura | 12 |
| 10 | thriller | Suspense | Suspense | 53 |

`discoverMoviesByGenre` deliberately sends NO `language` param (JellyseerrApi.kt:56-73)
— else `es-MX` collapses the result set (it's not an ISO-639-1 code and TMDB
applies `language` as `with_original_language` on discover).

### +18 / adult section (gating, PIN, library, AniList)

- **Gating**: `AppSettings.adultUnlocked` (`data/settings/AppSettings.kt:43-44`)
  is an in-memory, session-scoped flag (resets on cold start). While locked,
  Home shows `AdultLockedRow` — a poster-shaped tile with a Lock icon + "+18
  BLOQUEADO" that opens `AdultPinOverlay` (`HomeScreen.kt:244-246, 294-351`).
- **PIN**: `AdultPinOverlay` (`ui/home/AdultPinOverlay.kt`) — numeric D-pad pad
  (dots feedback, auto-submit at PIN length, wrong-PIN clears + "PIN incorrecto",
  BORRAR key, BACK dismisses). PIN value: `AppSettings.DEFAULT_ADULT_PIN = "6969"`
  (`AppSettings.kt:26`), user-changeable + persisted (`AppSettings.kt:70-75`).
  `submitAdultPin` → `AppSettings.tryUnlockAdult(pin)` (`HomeViewModel.kt:94`,
  `AppSettings.kt:77-82`).
- **When unlocked** (`HomeScreen.kt:232-243`): an `AdultSearchEntry` pill
  ("BUSCAR EN +18" → `onNavigateToAdultSearch`) + a "+18" `MediaRow` from
  `state.adultRow`.
- **Adult row data** (`HomeViewModel.kt:109-136`, `loadAdultRow`): parallel
  (a) library = `getCategoryRow(CategoryCatalog.ADULT)` → the dedicated Jellyfin
  "Adultos" library (name == "Adultos" or contains "adult",
  `MediaRepositoryImpl.kt:226-227`), no genre filter, posters enriched from
  AniList; (b) discover = `getAdultDiscoverRow()` → Prowlarr search for
  `ADULT_BROWSE_QUERY="hentai"` over `ADULT_INDEXER_IDS=[23,16]`
  (`ArrConfig.kt:27-29`), collapsed one-card-per-show, AniList-enriched.
  Discover items whose show is already in the library are dropped (title-key
  dedup). Loaded on unlock (`HomeViewModel.kt:85-90`).
- **AniList metadata**: adult items have no TMDB/Jellyfin poster; covers/info
  come from AniList by cleaned title (`MediaRepositoryImpl.kt:145-184`,
  `getAdultInfo` builds `AdultInfo` with synopsis/poster/banner/episodes/score/genres).
- **CategoryCatalog.ADULT** (`Category.kt:44-45`): id `adult`, label `+18`,
  `jellyfinGenre=null`, `tmdbMovieGenreId=null`, `adult=true`.

### Home focus/UX machinery
- Focus restoration across nav: last-focused poster key persisted in
  `rememberSaveable` + per-row scroll state, re-requested on Home re-entry
  (`HomeScreen.kt:108-136, 542-564`, `PosterFocusRestore`).
- Per-row independent loading/error/empty (`RowState` sealed, `HomeViewModel.kt:28-32`;
  `MediaRow` renders spinner/error/"Sin contenido por ahora", `HomeScreen.kt:481-540`).
- Polling started/stopped via `LifecycleResumeEffect` (`HomeScreen.kt:91-94`).

---

## 4. Every reusable component

| Component | File | What it does |
|---|---|---|
| `PosterCard` | `ui/components/PosterCard.kt` | Poster tile (124dp, 2:3). Focus = scale 1.05 + gold border + gold glow. Title below in reserved 20dp slot (brightens on focus). Optional `progressPercent` (dim-unwatched + bottom bar, or bar-only when `dimUnwatched=false`), optional `badge` slot, optional `onLongClick` (500ms D-pad hold, used by Downloads for cancel; intercepts key events so short-press still fires onClick). |
| `StatusBadge` | `ui/components/StatusBadge.kt` | Pill per `TitleStatus`: InLibrary="EN LIBRERÍA" (Poison green), Requesting="DESCARGANDO" (Accent gold), Requestable="PEDIR" (Text). `BadgeTextStyle` = 9.5sp uppercase. Tinted scrim bg. |
| `ConfirmOverlay` | `ui/components/ConfirmOverlay.kt` | Shared destructive-action confirm sheet. Dimmed backdrop, centered card, title + message + two right-aligned buttons. Safe/dismiss button FIRST (takes initial focus); BACK = dismiss. Visibility owned by caller (`remember mutableStateOf`). |
| `AdultPinOverlay` | `ui/home/AdultPinOverlay.kt` | Numeric PIN pad (see §3). Dots, auto-submit, error, BORRAR, BACK dismiss. |
| `PoisonKeyboard` | `ui/search/PoisonKeyboard.kt` | In-app on-screen keyboard (dark, gold focus, D-pad). Rows: digits/symbols toggle top row, `qwertyuiop`, `asdfghjklñ`, `zxcvbnm`; bottom: `#&/123` toggle, SpaceBar (216dp), Backspace, Clear(✕). `firstKeyFocus` anchors to Q. Symbols set = `-':&.,!?@#`. |
| `PoisonBrand` / `PoisonMascot` / `PoisonSplash` | `ui/components/Brand.kt` | Brand lockup (mascot+wordmark), standalone mascot (time-of-day: morning/afternoon/night drawables, or stable `ic_poison_logo`), and pulsing splash. |
| `focusOnAppear` | `ui/components/Focus.kt` | Modifier that requests focus when a surface appears (combine with `focusGroup`). The single fix for TV focus-orphaning on overlays/sheets/menus. |
| `MediaRow` | `ui/home/HomeScreen.kt:481` | Home row: eyebrow + `TvLazyRow` of `PosterCard`s, with RowState state machine + "PEDIR" badge for requestable items. |
| `ContinueWatchingRow` / `DownloadingRow` | `ui/home/HomeScreen.kt:381/422` | Specialized Home rows (resume %, download status badge). |
| `AudioTrackMenu` / `SubtitleTrackMenu` | `ui/player/TrackMenu.kt` | Player track pickers (see §8). |
| `PlayerControlsOverlay` / `PlayerIconButton` | `ui/player/PlayerScreen.kt:241/386` | Custom player transport overlay + gold-focus icon buttons. |
| `Hero` banner | — | **Not present in projector** (web app added it; see Gap Analysis). |

---

## 5. Every ViewModel

### `HomeViewModel` (`ui/home/HomeViewModel.kt`)
- State: `HomeUiState` (continueWatching, downloadingItems, libraryRow,
  discoverRow, 10 categoryRows, adultUnlocked, adultRow).
- Fetches: library/discover/category rows in `init` (each own coroutine).
  Re-fetches discover+categories on language toggle (`drop(1).collect`).
  Mirrors `adultUnlocked`, loads adult row on unlock.
- Polling: `startPolling`/`stopPolling` (ON_RESUME/ON_PAUSE). Downloads every
  **15s**, continue-watching every **20s** (`DOWNLOADING_REFRESH_MS`,
  `CONTINUE_WATCHING_REFRESH_MS`). Idempotent guards.
- Business logic: per-row isolation, library/discover dedup by tmdbId + by
  normalized title-key for adult (`normalizeTitleKey`), `submitAdultPin`.

### `DetailViewModel` (`ui/detail/DetailViewModel.kt`)
- State: `DetailUiState` (detail, loading/error, isRequesting, downloadProgress,
  seriesProgress, episodes, selectedSeason, isDeleting/isDeleted/deleteError,
  isCancelling/isCancelled/cancelError).
- `loadDetail`: parses mediaRef, fetches via `DetailRepository.getDetail`.
  Series also load episode list.
- Polling: `startProgressPolling` (Radarr/Sonarr % every **10s** while Requesting);
  `maybeStartEpisodePolling` (series episode list every **10s** while any episode
  downloading). Both paused on ON_PAUSE.
- Actions: `onRequestClick` (Prowlarr grab vs Jellyseerr request branch),
  `onDeleteClick` (Radarr/Sonarr delete-with-files, or Jellyfin deleteItem for
  +18 tmdb-less items), `onCancelClick` (`RequestRepository.cancelDownload`),
  `onSeasonSelected`.
- `seriesCompleteness(episodes)` (0..99, avg readiness), `defaultSeasonFor`.

### `SearchViewModel` (`ui/search/SearchViewModel.kt`)
- State: `SearchUiState` (query, results, selectedRef/selectedItem/selectedDetail,
  isDetailLoading, isRequesting, isRecommended, hasSearched).
- `adult` flag toggles Prowlarr vs Jellyseerr.
- `loadRecommended`: empty-query trending (falls back to library so never blank;
  adult uses adult discover). `onQueryChange`: **350ms debounce**
  (`DEBOUNCE_MS`), min 2 chars, else recommended. `runSearch`: adult→Prowlarr
  `searchAdult`; normal→`SearchRepository.search`. Auto-selects first result.
- `onSelect(item)`: **220ms debounce** (`DETAIL_DEBOUNCE_MS`) loads the
  highlighted item's full detail into the preview, with a stale-load guard on
  `selectedRef`. `onRequestSelected`: Prowlarr grab vs Jellyseerr request,
  updates preview + matching carousel badge in place.
- Re-runs on language toggle.

### `PlayerViewModel` (`ui/player/PlayerViewModel.kt`) — see §8.

### `DownloadsViewModel` (`ui/downloads/DownloadsViewModel.kt`) — see §9.

### `OnboardingViewModel` (`ui/onboarding/OnboardingViewModel.kt`)
- State: `OnboardingUiState` (urls, username, password, isLoading, failedBackend,
  errorMessage, loginSucceeded).
- `onConnectClick`: validates non-blank, then sequential Jellyfin
  `authenticateByName` → on success Jellyseerr `authenticate` (parses
  `Set-Cookie` `connect.sid`). Both-or-nothing: only commits both sessions to
  `CredentialStore` + `SessionPreferencesStore` if BOTH succeed
  (`OnboardingViewModel.kt:130-142`). `failedBackend` attributes the failure.

### `SessionBootstrapViewModel` (`ui/onboarding/SessionBootstrapViewModel.kt`)
- Decides start destination (Loading→Onboarding|Home). Restores persisted
  session on boot; observes both session flows continuously — if either drops
  to null while on Home (401 invalidation), clears persisted session and routes
  to Onboarding.

---

## 6. Every data source / API call per feature

### Jellyfin (`data/remote/JellyfinApi.kt`)
| Endpoint | Method | Used by |
|---|---|---|
| `Users/AuthenticateByName` | POST | Onboarding login |
| `Users/{userId}/Views` | GET | resolve libraries (cached), category scoping |
| `Users/{userId}/Items` | GET | library row, genre "para ver" (Genres+ParentId), episode list |
| `Users/{userId}/Items/Resume` | GET | "Continuar viendo" row |
| `Users/{userId}/Items/{itemId}` | GET | Detail (jf ref), resume position (Fields=UserData) |
| `Items/{itemId}` | DELETE | +18 library-delete (Jellyfin-only titles) |
| `Items/{itemId}/PlaybackInfo` | POST | StreamResolver (DirectPlay vs Transcode) |
| `Sessions/Playing` | POST | playback start report |
| `Sessions/Playing/Progress` | POST | heartbeat + pause/seek |
| `Sessions/Playing/Stopped` | POST | player exit |

### Jellyseerr (`data/remote/JellyseerrApi.kt`)
| Endpoint | Used by |
|---|---|
| `api/v1/auth/jellyfin` | Onboarding (cookie session) |
| `api/v1/search?query=` | unified Search |
| `api/v1/discover/trending` | Tendencias/Descubrir row, Search recommended |
| `api/v1/discover/movies?genre=` | genre row "para descargar" (movies) |
| `api/v1/discover/tv?genre=` | genre row (TV counterpart; declared, same rationale) |
| `api/v1/movie/{tmdbId}` | Detail (movie), localized overview |
| `api/v1/tv/{tmdbId}` | Detail (TV) |
| `api/v1/request` (POST) | "Pedir" request creation |
| `api/v1/request?take&skip&filter=all` (GET) | Downloads list + "En camino" |
| `api/v1/request/{id}` (DELETE) | cancel removes the request record |

### Prowlarr (`data/remote/ProwlarrApi.kt`) — +18 only
- `GET api/v1/search` (query, indexerIds, X-Api-Key) — adult discover/search.
- `POST api/v1/search` `{guid, indexerId}` — grab the release ("Pedir" for +18).

### Radarr / Sonarr (`data/remote/ArrApi.kt`)
- Radarr: `GET api/v3/queue` (progress %), `GET api/v3/movie` (identity by tmdbId),
  `DELETE api/v3/movie/{id}?deleteFiles=true` (library-delete),
  `DELETE api/v3/queue/{id}` (cancel transfer), `GET/PUT api/v3/movie/{id}` raw
  JsonElement (unmonitor without corrupting fields).
- Sonarr: `GET api/v3/queue` (progress %), `GET api/v3/series` (identity),
  `GET api/v3/episode` (full episode list, hasFile), `GET api/v3/queue?includeEpisode`
  (episode-level %), `DELETE api/v3/series/{id}?deleteFiles=true` (delete),
  `PUT api/v3/episode/monitor` (batch unmonitor after cancel),
  `DELETE api/v3/queue/{id}` (cancel transfer).
- Config: `ArrConfig.kt` — ports Radarr 7878 / Sonarr 8989 / Prowlarr 9696,
  base URLs derived from Jellyfin host, API keys from `BuildConfig`
  (gitignored local.properties).

### AniList (`data/remote/AniListApi.kt`) — +18 posters/info
- GraphQL `POST` to `https://graphql.anilist.co/` (no key). `COVER_QUERY`
  (cover only), `DETAIL_QUERY` (cover, banner, title, description, episodes,
  averageScore, genres). Enriches Prowlarr/adult library items lacking artwork.

### Network wiring
- `di/AppContainer.kt` builds each repository per session (fresh instances;
  `DownloadProgressProvider` is a shared singleton for TTL-cache coalescing).
- Auth: `X-Emby-Token` header (Jellyfin) / `connect.sid` cookie (Jellyseerr)
  injected by interceptors; `LanguageInterceptor` injects `es-MX`/`en` into any
  Jellyseerr request that already declares `language`.

---

## 7. Detail screen specifics

`ui/detail/DetailScreen.kt` + `DetailViewModel.kt`. Detail is resolved from
`MediaRef` by `DetailRepositoryImpl.getDetail` (`data/repository/DetailRepositoryImpl.kt`):
- `MediaRef.Jellyfin` → definitionally `InLibrary`, fetched from Jellyfin
  (`getItem`), overview re-localized via Jellyseerr if it has a tmdbId.
- `MediaRef.Tmdb` → Jellyseerr movie/tv detail + `LibraryIndex.resolve` re-derives
  status (tmdb match, or title+year fallback).
- `MediaRef.Adult` → built from AniList info + carries Prowlarr guid/indexerId;
  status = `Requestable`.

### MOVIE layout (`MovieDetailContent`, `DetailScreen.kt:222-264`)
- Backdrop + scrim, single hero: poster (220dp, in-poster borderless play button
  when playable) + title/year/rating/genres/overview + "Audio disponible: …".
- Smart action + secondary action per status.

### TV SERIES layout — two-pane (`SeriesDetailContent`, `DetailScreen.kt:396-617`)
- LEFT fixed pane: poster (in-poster play plays FIRST available episode, since
  a whole-series id returns HTTP 500 from Jellyfin PlaybackInfo — only episodes
  play, `DetailScreen.kt:426-484`), title, series-level progress bar, smart/
  secondary action, TEMPORADAS season selector (`TvLazyColumn`, focus/click both
  update right pane, `SeasonRow.kt:619-666`).
- RIGHT pane: selected season's episodes (`EpisodeRow`), scrolls independently.
  Each episode row: 16:9 still + "S1·E2 — Title" + status line + trailing icon.
- Episode statuses (`domain/model/Episode.kt`): `Available(jellyfinItemId)` (play),
  `Downloading(percent)` (own % bar), `Missing` ("En cola"). Merged from Jellyfin
  (playable truth) + Sonarr (full list + queue %) in `EpisodeRepositoryImpl.kt`.
- `seriesProgress` = whole-series completeness (avg readiness, 0..99), shown as
  one global bar when playable; else the poster shows the % takeover.

### Context-aware smart action (`SmartActionButton`, `DetailScreen.kt:1016-1042`)
Per `TitleStatus` (`domain/model/TitleStatus.kt`):
- `InLibrary` → "Reproducir" (in-poster play; button hidden in hero, on-poster instead).
- `Requestable` → "Pedir" (gold; hint "Se buscará en audio Dual (español + inglés)").
- `Requesting(jellyseerrStatus)` → disabled button showing `jellyseerrStatusLabel`
  (Pendiente/Descargando/Parcialmente disponible/Disponible), hint "En camino · …".

### Secondary action (`SecondaryActionButton`, exactly one per status)
- `InLibrary` → "Eliminar" (opens delete ConfirmOverlay → `onDeleteClick`).
- `Requesting` → "Cancelar" (opens cancel ConfirmOverlay w/ dismissLabel
  "No, seguir" → `onCancelClick`).
- `Requestable` → none.
- Success of delete/cancel sets `isDeleted`/`isCancelled` → auto `popBackStack`.

### States: loading spinner, error text, loaded (movie|series). Request/delete/
cancel each have their own busy flag + error text rendered inline.

---

## 8. Player specifics

`ui/player/PlayerScreen.kt`, `PlayerViewModel.kt`, `TrackMenu.kt`;
`player/StreamResolver.kt`, `PlaybackController.kt`, `DeviceProfileFactory.kt`.

### Stream resolution (`StreamResolverImpl.resolve`)
- POSTs `PlaybackInfo` with a device profile. `DeviceProfileFactory.create()` =
  conservative direct-play whitelist; `createForcedTranscode()` guarantees a
  `TranscodingUrl`. If `TranscodingUrl` present → `PlaybackSource.Transcoded(HLS)`,
  else `PlaybackSource.DirectPlay(Videos/{id}/stream?static=true&mediaSourceId=)`.
- Enumerates ALL audio + text-subtitle tracks (`AudioTrack`/`SubtitleTrack`).
- Resume position: second `getItem?Fields=UserData` call → `PlaybackPositionTicks`,
  with a **5s back-off** so it doesn't resume on the exact stopped frame
  (`resumePositionMsFromTicks`, `StreamResolver.kt:179-182`).
- `preferredAudioStreamIndex` bakes a specific audio stream into a transcode URL.

### DirectPlay vs Transcode (`PlaybackController.open`)
- DirectPlay: `setMediaItem(url, startPositionMs)` — initial position honored.
- Transcoded: HLS (`.m3u8`) → `HlsMediaSource`; progressive `.ts` → default
  factory. Jellyfin transcodes from 0, so resume is a real `seekTo` AFTER
  STATE_READY (`applyPendingResumeSeek`, one-shot).
- Auth via `X-Emby-Token` request header on the data source factory.
- Volume always 1.0 — no in-app volume control (device physical buttons own it).

### Audio/subtitle track switching (`TrackMenu.kt` + VM)
- Audio: DirectPlay → Media3 `TrackSelectionOverride` (ordinal-matched groups).
  Transcode → re-resolve PlaybackInfo with the picked `AudioStreamIndex` and
  reopen at current position (`switchAudioUnderTranscode`).
- Subtitle: sideloaded `SubtitleConfiguration`s; matched by `trackGroupId`
  (with the `:`-prefix fix for HLS, `PlaybackController.kt:274-275`). "Ninguno"
  always offered. Initial subtitle: saved preference → language-family match →
  AUTO rule (subs ON in app language when audio isn't; `resolveInitialSubtitle`).
- Menu UX: language names humanized (`languageDisplayName`), Spanish+English
  surfaced first, rest folded behind "Más subtítulos"; best-per-language dedup.
  Subtitle choice persisted via `AppSettings.setSubtitlePreference`.

### Resume + heartbeat + controls
- `Sessions/Playing` once on open; `Sessions/Playing/Progress` every **10s**
  (`HEARTBEAT_INTERVAL_MS`) AND immediately on play/pause/seek; `Sessions/Playing/
  Stopped` on screen-leave (fired from `DisposableEffect.onDispose` →
  `onScreenLeft`, NOT `onCleared`, because `viewModelScope` closes first).
- Position ticker every 500ms; `lastKnownPositionMs` used for transcode-fallback
  reopen (currentPosition collapses to 0 on decoder error).
- Transcode fallback: on first `onPlayerError`, silently retry via forced
  transcode at last position (EXACTLY once; error only surfaces if retry fails).
- Custom controls overlay (no Media3 controller): title + playback-mode label
  ("Directo"/"Transcodificando"/"…"), scrubber, times, transport (Replay10 /
  Play-Pause / Forward30; seek back 10s / forward 30s), top-right audio/subtitle
  buttons. Auto-hide after **4s** (`AUTO_HIDE_DELAY_MS`). D-pad focus redirect:
  UP from transport jumps to top options (root `onPreviewKeyEvent`).

### `PlaybackMode` (`PlayerViewModel.kt:38`): UNKNOWN / DIRECT_PLAY / TRANSCODED,
surfaced so the UI never claims direct-play while transcoding.

---

## 9. Downloads / delete / cancel — destructive flows

### Downloads screen (`ui/downloads/DownloadsScreen.kt`, `DownloadsViewModel.kt`)
- 5-column `TvLazyVerticalGrid` of `PosterCard`s. Each card: poster + status pill
  (`statusLabel` uppercased, green if "Disponible") + progress %. Header: "Descargas"
  + manual Refresh icon. Empty state: `PoisonMascot` + "No hay nada descargándose…".
- Data: `RequestRepository.getDownloads()` → `JellyseerrApi.getRequests(take=50,
  filter="all")`, each request enriched with title/poster (concurrent) + real %
  from `DownloadProgressProvider`. Auto-refresh every **15s** (`AUTO_REFRESH_INTERVAL_MS`),
  paused off-screen.
- Short-press card → Detail. **Long-press** (D-pad hold 500ms via
  `PosterCard.onLongClick`) → cancel ConfirmOverlay.

### Cancel flow (`RequestRepositoryImpl.cancelDownload`, `DownloadsViewModel.onCancelClick`)
- Resolves tmdbId → Radarr movie / Sonarr series; deletes queue item(s)
  (`removeFromClient=true, blocklist=false`), unmonitors (movie-level raw PUT,
  or `monitored && !hasFile` episodes), AND deletes the Jellyseerr request record
  so the title fully disappears from "En camino". Each step is independent/
  best-effort — empty queue is normal (torrent may never have started); only a
  title unresolvable EVERYWHERE throws `ArrIdentityException`.
- VM: optimistic removal + `DownloadProgressProvider.invalidate()` (busts 8s TTL)
  + `recentlyCancelledRequestIds` guard against the propagation window; auto-
  refresh paused during the call. Also exposed from Detail (`onCancelClick`).

### Delete flow (`DetailRepositoryImpl.deleteMovie/deleteSeries/deleteLibraryItem`)
- Radarr/Sonarr `DELETE …?deleteFiles=true` (record + files) resolved by tmdbId;
  +18 tmdb-less titles delete straight through Jellyfin `DELETE Items/{id}`.
- Always behind `ConfirmOverlay`; success → auto-back.

---

## 10. Design system

### Colors (`ui/theme/Color.kt`, `PoisonFlixColors`)
| Token | Hex | Use |
|---|---|---|
| ScreenBg | `#0A0C10` | deep cinematic near-black background |
| Surface | `#12151C` | cards / sheets |
| Surface2 | `#1B1F29` | inputs / raised chips |
| Line | `#2A303C` | hairlines / unfocused borders |
| Text | `#F4F6FB` | primary text |
| Muted | `#98A1B3` | secondary text |
| Muted2 | `#5C6474` | tertiary / disabled |
| Accent | `#F2C14E` | brand gold — focus rings, CTAs (sparingly) |
| AccentSoft | `#F7D98A` | softened gold (genres, hovers) |
| AccentGlow | `#59F2C14E` | translucent gold focus glow |
| Poison | `#8CFF5A` | toxic green — "available/ready" |
| PoisonDim | `#5FB23C` | muted toxic green |
| Scrim | `#E60A0C10` | 90% bg overlay over art |

### Typography (`ui/theme/Type.kt`)
- One sans ramp (`FontFamily.SansSerif`). `LabelMono` = 12sp uppercase, 0.18em
  tracking — the reusable "eyebrow" for section headers/pills/meta.
- Scale: displayLarge 44 / displayMedium 36 / displaySmall 30 / headlineLarge 26
  / headlineMedium 22 / headlineSmall 19 / titleLarge 18 / titleMedium 16 /
  titleSmall 14 / bodyLarge 15 / bodyMedium 14 / bodySmall 13 / labelLarge 14 /
  labelMedium 12 / labelSmall = LabelMono.

### Theme (`ui/theme/Theme.kt`)
- Dark-only. Wraps BOTH `androidx.tv.material3` (focus/D-pad) and base
  `androidx.compose.material3` (text fields, progress) color schemes so both
  render on the dark palette.

### Visual language
- Cinematic near-black base + a single warm gold accent used sparingly (focus
  rings, brand, primary CTAs) + toxic-green for "ready". Everything else a cool
  neutral ramp. Focus = modest scale + gold border + gold glow. Kawaii
  poison-drop mascot as the brand face (time-of-day variants).

---

# GAP ANALYSIS — Projector vs Web app

Web app root: `/home/alexis/Documentos/poisonflix-web`. Built via 8 SDD slices
(`openspec/changes/poisonflix-web/apply-progress.md`). Web features present:
`onboarding`, `home`, `search`, `detail`, `player`. Web hooks: `useLibraryRow`,
`useTrendingRow`, `useSearch`, `useMovieDetail`, `useRequestMedia`,
`usePlaybackInfo`, `usePlaybackHeartbeat`, `useDebouncedValue`, `useAuth`.
**No** downloads feature, **no** adult, **no** genre/category hooks, **no**
continue-watching/downloading rows.

The web MVP explicitly deferred (per apply-progress "Deferred" notes): Continue
Watching, Downloading rows, genre rows, +18 PIN, TV two-pane detail, webOS build.

### Legend: MISSING = feature exists in projector but not in web app.

| Feature / element | In projector? | In web app? | MISSING? | Notes / port target |
|---|---|---|---|---|
| **NAVIGATION** | | | | |
| Onboarding→Home start-destination bootstrap | yes | yes | no | `SessionBootstrapVM` ≈ web `AuthContext`+`RouteGuard`/`PublicOnlyRoute` |
| Session invalidation (401) → re-onboard | yes | partial | partial | web clears session on 401 in `client.ts`; verify it routes back to onboarding |
| `/search_adult` route | yes | **no** | **YES** | no adult search route in web |
| `/downloads` route | yes | **no** | **YES** | no downloads screen at all in web |
| `detail/{mediaRef}` opaque ref scheme (jf/tmdb/adult) | yes | partial | partial | web `/detail/:id` uses TMDB id only; no jf/adult ref forms |
| **HOME ROWS** | | | | |
| Top bar: brand + Search + Downloads icons | yes | partial | partial | web `Header` has brand + search link; **no Downloads icon** |
| Language chip ES⇄EN (TMDB metadata toggle) | yes | **no** | **YES** | `AppSettings.toggleLanguage`; web hardcodes `es-MX` |
| Continuar viendo (resume) row | yes | **no** | **YES** | `getResumeItems`; deferred in web MVP |
| En camino (downloading) row | yes | **no** | **YES** | `getDownloads` filtered; deferred |
| En tu librería (library) row | yes | yes | no | web `useLibraryRow` |
| Tendencias / Descubrir row | yes | yes | no | web `useTrendingRow` |
| 10 genre/category rows (Acción…Suspense) | yes | **no** | **YES** | `CategoryCatalog.NORMAL`; **entire feature absent from web** |
| Mixed genre rows (library "para ver" + discover "para descargar") | yes | **no** | **YES** | `getCategoryRow` merge logic to port |
| +18 locked tile + PIN overlay | yes | **no** | **YES** | `AdultLockedRow` + `AdultPinOverlay`, PIN `6969` |
| +18 unlocked row (Adultos library + Prowlarr + AniList) | yes | **no** | **YES** | whole adult pipeline absent |
| "BUSCAR EN +18" entry pill | yes | **no** | **YES** | opens adult search |
| Home hero/featured banner | **no** | **yes** | n/a | web ADDED a `Hero` component not in projector |
| Per-row independent loading/error/empty | yes | yes | no | web `Row` isolation (ADR-3) matches |
| Focus restoration across nav | yes | n/a | n/a | TV-specific; web uses browser focus |
| Home polling (downloads 15s / resume 20s) | yes | **no** | **YES** | tied to the two missing rows |
| **SEARCH** | | | | |
| Debounced search-as-you-type (350ms) | yes | yes | no | web `useDebouncedValue(350)` |
| Unified status badge (LibraryIndex correlation) | yes | yes | no | web `libraryIndex.ts` ported |
| Dedup by tmdb id | yes | yes | no | web `dedup.ts` |
| On-screen keyboard (`PoisonKeyboard`) | yes | **no** | **YES** | web uses native `<input>` (deliberate; but a richer TV-style keyboard is a projector feature) |
| Results carousel (horizontal poster rail) | yes | yes | no | web reuses `Row`/`PosterCard` |
| Big live preview panel (poster+synopsis+audio/subs+action) | yes | partial | partial | web `BigPreview` shows poster/title/year/rating/badge/overview; **missing audio & subtitle language lines** |
| Preview loads full detail on carousel focus (220ms) | yes | partial | partial | web selects on focus but shows only the search result's fields, does NOT fetch full `MediaDetail` per item |
| Recommended (trending) when query empty | yes | partial | partial | verify web shows trending/library fallback for empty query |
| Inline request from search (Pedir) updates badge | yes | partial | check | web has request in Detail; confirm search-inline request path |
| Adult search mode (Prowlarr + AniList) | yes | **no** | **YES** | `SearchScreen(adult=true)` absent |
| Language re-fetch on toggle | yes | **no** | **YES** | tied to missing language chip |
| **DETAIL** | | | | |
| Movie hero (backdrop/poster/meta/overview/action) | yes | yes | no | web `DetailScreen` movie layout |
| Context-aware smart action (Play/Pedir/status) | yes | yes | no | web `DetailAction` matches all 3 states |
| "Audio disponible" line on detail | yes | **no** | **YES** | `MediaDetail.audioLanguages` not shown in web |
| Request (Pedir) → response.media.status (no optimistic) | yes | yes | no | web ports the exact rule |
| TV series two-pane (season selector + episode list) | yes | **no** | **YES** | web is movies-only; **whole series flow absent** |
| Episode statuses (Available/Downloading %/Missing) | yes | **no** | **YES** | `EpisodeRepositoryImpl` merge absent |
| Series-level progress bar / completeness | yes | **no** | **YES** | deferred |
| Play first-available-episode (series 500 workaround) | yes | **no** | **YES** | series-specific |
| Delete (Eliminar) w/ ConfirmOverlay | yes | **no** | **YES** | Radarr/Sonarr/Jellyfin delete flows absent from web |
| Cancel (Cancelar) from Detail w/ ConfirmOverlay | yes | **no** | **YES** | cancel flow absent from web |
| Live download-% polling on Detail (10s) | yes | **no** | **YES** | `downloadProgress`/`seriesProgress` absent |
| Localized overview re-fetch for library items | yes | n/a | n/a | tied to language toggle |
| +18 detail (AniList-backed) + Prowlarr grab | yes | **no** | **YES** | adult absent |
| **PLAYER** | | | | |
| DirectPlay (`<video>`/api_key) | yes | yes | no | web validated live (Slice 2/7) |
| Transcode HLS fallback | yes | yes | no | web `hls.js` (Slice 8), device profile ported |
| Resume position + 5s back-off | yes | partial | partial | web resumes from `PlaybackPositionTicks`; verify the 5s back-off is ported (`streamResolver.ts` note says back-off NOT ported) |
| Heartbeat Playing/Progress(10s)/Stopped | yes | yes | no | web `usePlaybackHeartbeat`, cadence verified live |
| Audio track selection menu | yes | **no** | **YES** | web player has no audio-track picker |
| Subtitle track selection menu (+ Ninguno, Más subtítulos, dedup) | yes | **no** | **YES** | web player has no subtitle picker |
| Subtitle auto rule + persisted preference | yes | **no** | **YES** | `resolveInitialSubtitle` / `AppSettings.subtitlePreference` absent |
| Transcode audio-switch (re-resolve w/ AudioStreamIndex) | yes | **no** | **YES** | HLS single-audio handling absent |
| Playback-mode label (Directo/Transcodificando) | yes | check | check | verify web surfaces transcode vs direct |
| Custom transport (seek ±10/30s, auto-hide 4s, D-pad) | yes | partial | partial | web has custom controls; auto-hide 3s, keyboard-operable; TV D-pad redirects n/a |
| Transcode decoder-error single retry | yes | partial | check | web hls.js fatal-error → error message; verify silent-retry parity |
| **DOWNLOADS SCREEN** | | | | |
| Downloads grid (Jellyseerr requests, status pills, %) | yes | **no** | **YES** | **entire screen absent from web** |
| Manual refresh + 15s auto-refresh | yes | **no** | **YES** | absent |
| Long-press to cancel + optimistic removal | yes | **no** | **YES** | absent |
| Empty state (mascot) | yes | **no** | **YES** | absent |
| **DATA/BACKENDS** | | | | |
| Jellyfin API (auth/items/resume/playback/sessions/delete) | yes | partial | partial | web has auth/items/playback/sessions; **no getResumeItems wired, no deleteItem** |
| Jellyseerr (search/trending/discover/detail/request) | yes | partial | partial | web has search/trending/movie-detail/request; **no discover-by-genre, no getRequests, no deleteRequest, no tv-detail** |
| Prowlarr (adult search/grab) | yes | **no** | **YES** | absent |
| Radarr/Sonarr (queue %/delete/cancel/unmonitor/episodes) | yes | partial | partial | web `arr.ts` has getMovie/setMonitored stub only (deferred, unwired); no queue/delete/cancel/episodes |
| AniList (adult posters/info) | yes | **no** | **YES** | absent |
| DownloadProgressProvider (TTL-cached % by tmdbId) | yes | **no** | **YES** | absent |
| LibraryIndex correlation (tmdb + title/year fallback) | yes | yes | no | web `libraryIndex.ts` |
| **DESIGN SYSTEM** | | | | |
| Palette (ScreenBg/Surface/Accent gold/Poison green…) | yes | yes | no | web `theme.css` (design.md §8 hex ported) |
| Typography ramp + LabelMono eyebrows | yes | partial | check | verify web has the uppercase-tracked eyebrow style |
| Poison-drop mascot brand asset | yes | yes | no | web `PoisonMark.tsx` (ported from `ic_poison_logo`) |
| StatusBadge (3 variants, colors) | yes | yes | no | web `StatusBadge.tsx` |
| PosterCard (focus scale/glow, progress, badge) | yes | partial | partial | web `PosterCard` lacks progress-bar overlay + long-press |
| ConfirmOverlay (destructive confirm) | yes | **no** | **YES** | needed once delete/cancel land |

### Biggest gaps to drive integration (ruthless summary)
1. **Genre/category rows** — all 10 (`CategoryCatalog.NORMAL`) + the mixed
   library-"para ver" / discover-"para descargar" merge. Entirely absent.
2. **+18 / adult** — locked tile, PIN overlay (`6969`), Adultos library, Prowlarr
   discover/search/grab, AniList enrichment, adult detail, `/search_adult`.
   Entire pipeline absent.
3. **Downloads screen** — whole screen + cancel flow (Radarr/Sonarr queue delete +
   unmonitor + Jellyseerr request delete) + long-press cancel + auto-refresh.
4. **Continuar viendo** + **En camino** home rows (resume feed + downloading feed
   with live %).
5. **Richer search UX** — on-screen `PoisonKeyboard`, and the big preview fetching
   full per-item detail incl. audio/subtitle language lines.
6. **TV series detail** — two-pane season/episode browser, episode statuses,
   series completeness, first-available-episode play.
7. **Delete/Cancel from Detail** + `ConfirmOverlay` + live download-% polling.
8. **Player track menus** — audio + subtitle selection, subtitle auto rule +
   persistence, transcode audio-switch.
9. **Language toggle** (ES⇄EN) chip + re-fetch, and the 5s resume back-off.
10. **Missing API surface**: Prowlarr, AniList, Radarr/Sonarr write/queue/episode
    endpoints, Jellyseerr discover-by-genre/getRequests/deleteRequest/tv-detail,
    Jellyfin resume/deleteItem, DownloadProgressProvider.
