# Exploration: poisonflix-web (PWA/webOS client over Jellyfin + Jellyseerr + *arr stack)

Reference app read: `/home/alexis/Documentos/poisonflix` (Kotlin Compose-for-TV, package com.hy300.poisonflix).

## Current State
Reference app: Kotlin Compose-for-TV, MVVM, no DI framework (manual composition via `di/AppContainer.kt`), Retrofit + OkHttp + kotlinx.serialization, Media3/ExoPlayer. Talks to Jellyfin (auth + media + playback), Jellyseerr (TMDB search/discover/request), Radarr/Sonarr/Prowlarr, AniList (adult metadata only). Jellyfin auth = bearer token (`X-Emby-Token`); Jellyseerr auth = session cookie (`connect.sid`). Both persisted via `EncryptedSharedPreferences`. Android has **zero CORS exposure** today — this is the single biggest new problem class for the web port.

## What to Port — API Contracts (file:line)

**Jellyfin** (`data/remote/JellyfinApi.kt`):
- `POST Users/AuthenticateByName` (L34-38), header built via `buildEmbyAuthorizationHeader` (L118-124). Response `JellyfinAuthResponse{User{Id,Name}, AccessToken, ServerId}` (`dto/JellyfinDto.kt` L27-38).
- `GET Users/{userId}/Items` (L51-63) — library/discover rows.
- `GET Users/{userId}/Items/Resume` (L72-81) — Continue Watching.
- `POST Items/{itemId}/PlaybackInfo` (L95-99).
- `POST Sessions/Playing`, `/Progress`, `/Stopped` (L102-109) — heartbeat every ~10s.
- Token injection: `data/auth/AuthInterceptor.kt` L24-38 (`JellyfinAuthInterceptor`), clears session on 401, no retry.

**Jellyseerr** (`data/remote/JellyseerrApi.kt`):
- `POST api/v1/auth/jellyfin` (L32-33) — only `{username,password}` against a pre-provisioned server (sending hostname/port → 500; `dto/JellyseerrDto.kt` L11-25). No token in body — session lives in `Set-Cookie: connect.sid=...`, parsed by `parseSessionCookie` (`data/auth/CredentialStore.kt` L70-77), replayed via `Cookie` header (`AuthInterceptor.kt` L45-59).
- `GET api/v1/search` (L37-41), `GET api/v1/discover/trending` (L49-53) — both send `language=es-MX`.
- `GET api/v1/discover/movies` / `.../tv` (L68-79) — **deliberately omit `language`** (see gotcha below).
- `POST api/v1/request` (L95-96) — body `JellyseerrRequestCreate{mediaType, mediaId, seasons:"all"|null}`.
- `GET api/v1/request?filter=all` (L107-112) — Downloads source, `all` needed to include already-AVAILABLE requests.

**Arr stack** (`ArrConfig.kt` L13-41, `RequestRepositoryImpl.kt` L53-109): Radarr :7878 / Sonarr :8989 / Prowlarr :9696, derived by swapping Jellyfin's host port. Auth = per-call `X-Api-Key`. Cancel-download does list-scan-by-tmdbId (no direct lookup endpoint), delete queue record(s), then unmonitor via GET-raw-JSON -> flip `monitored:false` -> PUT-back-unmodified (L99-108) — round-tripping a typed DTO would silently drop fields since `ignoreUnknownKeys=true`.

## What to Port — Business Logic
- Search debounce 350ms / min 2 chars (`ui/search/SearchViewModel.kt` L106-119, L238); detail-preview debounce 220ms (L174).
- `distinctBy(id)` on TMDB results (`data/repository/SearchRepositoryImpl.kt` L23).
- Unified status badge: `LibraryIndex` (`data/repository/LibraryIndex.kt`) — primary match on Jellyfin `ProviderIds.Tmdb`, fallback title+year match (L23-30, L49-52), resolves `TitleStatus.InLibrary|Requesting|Requestable` (L40-63).
- "Pedir" flow: `DetailRepositoryImpl.requestMedia` (L120-134) — posts to Jellyseerr, reads `response.media.status` (not the request's own workflow status).
- Continue Watching: Jellyfin `/Items/Resume`, polled every 20s (`HomeViewModel.kt` L172-184). Downloading row: Jellyseerr requests polled every 15s (L154-171).
- +18 PIN gate: `ui/home/AdultPinOverlay.kt`, numeric pad, auto-submit at configured length, session-scoped unlock (`HomeViewModel.kt` L84-90).
- Stream resolution (`player/StreamResolver.kt`): PlaybackInfo -> `TranscodingUrl` present => `PlaybackSource.Transcoded(hlsUrl)`, else `DirectPlay(url)` built as `Videos/{itemId}/stream{ext}?static=true&mediaSourceId=...` (L196-200); resume position ticks->ms with 5s back-off (L179-182).
- Codec whitelist (`player/DeviceProfileFactory.kt` L53-99): conservative H.264/AAC-only direct-play profile, **explicitly never device-confirmed even natively** (L44-51) — do not treat as a validated reference for web.

## UX/IA
Onboarding (2-panel, 4 fields, both backends must auth before any persistence — `OnboardingViewModel.kt` L44-51/L130-142) -> Home (Continue Watching, Downloading, Library, Trending, 10 genre rows `domain/model/Category.kt` L30-41, PIN-gated +18) -> Search (carousel + big preview panel) -> Detail (context-aware action, two-pane season/episode for TV) -> Player (auto-hide controls, track menus, silent one-shot transcode fallback). Theme: near-black `#0A0C10`, gold accent `#F2C14E`, toxic green `#8CFF5A` for "available" states (`ui/theme/Color.kt`, `Type.kt`).

## Documented Past Mistakes to Not Repeat
- **Language-param footgun** (`LanguageInterceptor.kt` L15-27 + `JellyseerrApi.kt` L58-67): the interceptor rewrites any *existing* `language` query param to `es-MX`. On `/discover/movies|tv`, Jellyseerr treats `language` as a TMDB content filter, not a locale — `es-MX` isn't ISO-639-1 and collapsed results to zero. Fix was to omit the param entirely on those two endpoints. Port the distinction, not just the interceptor.
- **AV1/codec whitelist**: never device-validated natively; for web this needs its own investigation per target (browser vs webOS Chromium) — only the *pattern* (conservative direct-play + server transcode fallback) transfers, not the actual codec table.
- **HLS subtitle id-prefix bug** (`PlaybackController.kt` L265-275): Media3 prefixes sideloaded subtitle `Format.id` under HLS merge (`"11:sub-12"` vs `"sub-12"` for DirectPlay); exact `==` silently broke every subtitle selection under transcode. hls.js has its own text-track id semantics — must verify this class of bug doesn't recur.
- **Resume-seek only works after ready under transcode** (`PlaybackController.kt` L96-104, L199-205): DirectPlay honors an initial seek; HLS does not — needs an explicit seek-after-ready. This logic lives in the Media3 wrapper, not `StreamResolver`, so it must be deliberately ported to the `<video>`/hls.js layer.
- **Focus-loss**: correctly N/A for browser/mobile, but **not** N/A for webOS — LG remotes are D-pad-first, so a variant of this exact problem class returns for that one target.

## Approaches
1. **React + Vite + TS + TanStack Query + vite-plugin-pwa (as decided)** — Effort: Low. TanStack Query is a near 1:1 replacement for the native row-isolation pattern (independent `Result<T>` rows + polling -> independent `useQuery`/`refetchInterval`). Con: webOS Chromium version varies hard by TV generation (webOS 3.x ~ Chromium 38 vs webOS 22+ ~ 87-94) — needs a conservative build target.
2. **SolidJS/Preact instead of React** — smaller runtime for old webOS, but relitigates a decided choice. Not recommended.
3. **Full LG Enact vs plain React + standalone spatial-nav** — Recommended: use `@enact/spotlight` standalone or `norigin-spatial-navigation`, scoped only to the webOS build behind a platform shim; not full Enact.

## Key Risks / New Problems (did not exist natively)
- **CORS (highest risk)**: browser/webOS origin -> Jellyfin `:8096` + Jellyseerr `:5055` cross-origin. Custom headers (`X-Emby-Token`) trigger preflights; Jellyseerr cookie auth needs `SameSite=None; Secure` (HTTPS) to survive cross-origin or the cookie is dropped. Options: (a) server-side CORS config, (b) **reverse proxy (nginx/Caddy/Traefik) making app + both backends same-origin via path routing — likely cleanest, also solves the cookie SameSite issue**, (c) a thin edge/backend (contradicts "thin client"). Infrastructure decision needing explicit user buy-in.
- **Auth token storage**: no browser equivalent of Android Keystore. localStorage/IndexedDB is unencrypted (XSS-exposed). Realistic posture: accept exposure for a personal-LAN tool (same threat model the native app already documents), state it explicitly.
- **Video playback**: `<video>` has no native HLS outside Safari -> needs hls.js for Chromium/webOS. `<video>` also cannot send custom auth headers like Media3 -> DirectPlay auth needs verification (Jellyfin `api_key` query-string fallback, or Blob+`createObjectURL`). HLS resume-seek-after-ready and subtitle-id-matching must be re-implemented against hls.js.
- **webOS packaging**: Chromium fragmentation across TV generations; `.ipk` apps run full-screen, D-pad-first (reintroduces focus-navigation); vite-plugin-pwa install-prompt is a no-op inside webOS. PWA and webOS are two distribution mechanisms sharing one codebase, not one serving both.

## Recommendation
Proceed with the decided stack. Treat CORS/reverse-proxy as a proposal-phase go/no-go infrastructure decision, scope webOS D-pad nav as a small standalone library (not full Enact), and sequence MVP to prove DirectPlay `<video>` + auth before investing in hls.js/transcode.

**MVP scope**: Onboarding (gates on CORS fix) -> Home with library + trending rows only (defer 10 genre rows) -> Search + Detail movies-only (defer TV episode two-pane) -> Player DirectPlay-only via `<video>` (defer HLS.js/transcode). Browser target only (defer webOS `.ipk` + PWA install/offline). Defer: Continue Watching/Downloading polling, +18 PIN row, category rows, HLS transcode + track switching, webOS packaging + spatial nav, delete/cancel-download.

## Open decisions for the Proposal phase
1. CORS strategy as a go/no-go gate (recommend reverse proxy).
2. MVP slice boundaries (per above).
3. webOS spatial-navigation library choice.
4. Auth-storage risk acceptance for a personal-LAN deployment.
