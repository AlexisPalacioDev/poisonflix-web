# Design: poisonflix-web

Status: designed
Change: `poisonflix-web`
Reads: proposal.md, explore.md, specs/{onboarding,home,search,detail-request,player}
Feeds: `sdd-tasks`
Reference: `/home/alexis/Documentos/poisonflix` (Kotlin Compose-for-TV, `com.hy300.poisonflix`)

## 1. Architecture overview

poisonflix-web is a **thin, same-origin SPA**. The browser is the only runtime that touches the backends; there is no edge/server code in this repo. The reverse proxy (Decision 1, owned by ops) makes the app, Jellyfin, and Jellyseerr share one origin under path prefixes, so the client only ever issues **relative** requests.

The Kotlin clean-layer separation is preserved 1:1 in a React idiom. Each Kotlin layer maps to exactly one web layer, and the mapping is the organizing principle of the whole codebase:

| Kotlin (reference) | poisonflix-web layer | Location |
| --- | --- | --- |
| `data/remote/*Api.kt` + `dto/*Dto.kt` | Typed fetch clients + schemas | `src/api/` |
| `data/auth/AuthInterceptor.kt` + `CredentialStore.kt` | Fetch wrapper + session store | `src/lib/http`, `src/lib/session` |
| `data/repository/*Impl.kt` + `LibraryIndex.kt` | Pure mappers/index helpers | `src/lib/domain/` |
| `ui/*ViewModel.kt` (row isolation, polling, debounce) | TanStack Query hooks | `src/hooks/` |
| `ui/components/*` | Presentational components | `src/components/` |
| `ui/*Screen.kt` + `ui/navigation/*` | Feature screens + router | `src/features/`, `src/routes/` |
| `ui/theme/Color.kt` / `Type.kt` | CSS variables | `src/styles/theme.css` |
| `player/StreamResolver.kt` + `PlaybackController.kt` | Stream resolver + `<video>` wrapper | `src/features/player/` |

**Data-flow direction (unidirectional, same as MVVM):**
`component → query hook (useQuery/useMutation) → api client → http wrapper (injects auth) → proxy → backend`, and back up as typed, validated data. Components never call `fetch` or an api client directly; they only consume hooks. Hooks never build URLs or headers; that is the api/http layer's job. Domain rules (badge computation, dedup, debounce) live in pure functions under `src/lib/domain` so they are unit-testable without React or network.

## 2. Project structure

```
poisonflix-web/
├─ index.html
├─ vite.config.ts                 # base config + PWA plugin + mode-driven platform flags
├─ tsconfig.json
├─ .env.development / .env.production / .env.webos   # VITE_* platform + path-prefix flags
├─ public/
│  └─ manifest / icons            # PWA assets (browser target)
└─ src/
   ├─ main.tsx                    # bootstrap: QueryClientProvider, AuthProvider, RouterProvider
   ├─ App.tsx                     # route tree mount + global chrome
   │
   ├─ api/                        # ← data/remote/*Api.kt  (URL building + typed calls, no auth logic)
   │  ├─ jellyfin.ts              #    JellyfinApi.kt
   │  ├─ jellyseerr.ts            #    JellyseerrApi.kt
   │  ├─ arr.ts                   #    ArrApi.kt + ArrConfig.kt (deferred surface, shape only)
   │  └─ schemas/                 # ← dto/*Dto.kt  (zod schemas + inferred TS types)
   │     ├─ jellyfin.ts
   │     └─ jellyseerr.ts
   │
   ├─ lib/
   │  ├─ http/
   │  │  ├─ client.ts             # ← AuthInterceptor.kt : fetch wrapper, auth injection, 401 handling
   │  │  └─ errors.ts             # ApiError vs NetworkError/CorsError (spec: proxy-vs-auth distinction)
   │  ├─ session/
   │  │  └─ store.ts              # ← CredentialStore.kt : localStorage read/write/clear
   │  ├─ domain/                  # ← data/repository/* pure logic (no React, no network)
   │  │  ├─ libraryIndex.ts       #    LibraryIndex.kt : status badge resolution
   │  │  ├─ streamResolver.ts     #    StreamResolver.kt : PlaybackInfo → DirectPlay URL
   │  │  ├─ dedup.ts              #    distinctBy(id)
   │  │  └─ config.ts             # ← ArrConfig.kt : host/port derivation (deferred surface)
   │  └─ platform/                # platform shim seam (Decision 3)
   │     ├─ index.ts              # exports the active platform impl by build mode
   │     ├─ platform.types.ts     # PlatformCapabilities interface
   │     ├─ browser.ts            # no-op navigation, real keyboard
   │     └─ webos.ts              # (deferred stub) norigin-spatial-navigation wiring
   │
   ├─ hooks/                      # ← ui/*ViewModel.kt  (one query hook per isolated concern)
   │  ├─ useAuth.ts               # consumes AuthContext
   │  ├─ useLibraryRow.ts         # Jellyfin Items row
   │  ├─ useTrendingRow.ts        # Jellyseerr trending row
   │  ├─ useSearch.ts             # debounced search + dedup + badge join
   │  ├─ useDebouncedValue.ts     # 350ms debounce primitive
   │  ├─ useMovieDetail.ts        # detail fetch + badge
   │  ├─ useRequestMedia.ts       # useMutation → POST request
   │  ├─ usePlaybackInfo.ts       # PlaybackInfo → resolved source
   │  └─ usePlaybackHeartbeat.ts  # Playing/Progress/Stopped
   │
   ├─ features/                   # ← ui/<screen>Screen.kt  (screen-level composition)
   │  ├─ onboarding/
   │  ├─ home/
   │  ├─ search/
   │  ├─ detail/
   │  └─ player/
   │     ├─ PlayerScreen.tsx
   │     └─ VideoSurface.tsx      # ← PlaybackController.kt : <video> wrapper (resume, heartbeat, hls seam)
   │
   ├─ components/                 # ← ui/components/*  (presentational, focus-friendly primitives)
   │  ├─ PosterCard.tsx
   │  ├─ StatusBadge.tsx
   │  ├─ Row.tsx                  # horizontal rail; row-scoped loading/error/retry
   │  ├─ Focusable.tsx             # focus primitive; browser = plain, webOS opts into spatial-nav later
   │  └─ Brand.tsx
   │
   ├─ auth/
   │  ├─ AuthContext.tsx          # session state + login/logout
   │  └─ RouteGuard.tsx           # redirect to /onboarding when unauthenticated
   │
   ├─ routes/
   │  └─ index.tsx                # React Router route tree
   │
   └─ styles/
      ├─ theme.css                # CSS variables (Color.kt / Type.kt tokens)
      └─ global.css
```

**Stack lock-in:** React 18, Vite 5, TypeScript (strict), `@tanstack/react-query` v5, `react-router-dom` v6, `zod` for response validation, `vite-plugin-pwa`. Testing: `vitest` + `@testing-library/react`. No component/UI kit — hand-rolled CSS with variables keeps the bundle small for the conservative webOS Chromium target (Decision 3) and avoids relitigating styling later.

## 3. API client layer

**Path prefixes (env-driven, same-origin relative):**
```
VITE_JELLYFIN_BASE   = /jellyfin
VITE_JELLYSEERR_BASE = /jellyseerr
```
All requests are relative to the app origin. No hostnames in the client — the proxy owns routing (Decision 1). Onboarding still captures the two server URLs per spec, but in the same-origin model they are informational/validation-only; requests go through the fixed prefixes. (If a deployment ever needs runtime-configurable prefixes, they resolve from the session store, but the default is the env prefix.)

### 3.1 HTTP wrapper — `lib/http/client.ts` (← `AuthInterceptor.kt`)

A single `apiFetch(base, path, init)` function replaces the two OkHttp interceptors:

- **Jellyfin auth:** inject `X-Emby-Token: <accessToken>` header on every Jellyfin call (from session store). Same-origin means no CORS preflight burden on the custom header (Decision 1a).
- **Jellyseerr auth:** send `credentials: 'include'` so the browser replays the same-origin `connect.sid` cookie automatically — the manual `Cookie` header (`AuthInterceptor.kt` L45-59) is **gone**; the browser does it. This is the key simplification the reverse proxy buys.
- **401 handling:** on 401 from either backend, clear the session (mirror `AuthInterceptor.kt` L24-38: clear, no retry) and let the route guard bounce to onboarding.
- **Error typing (`lib/http/errors.ts`):** a thrown `fetch` (TypeError) or opaque failure → `NetworkError`/`CorsError`; an HTTP non-2xx → `ApiError(status)`. This distinction is **required by the onboarding spec** (proxy/CORS failure MUST read differently from a 401 auth failure). This is the seam that satisfies "Clear error on proxy/CORS misconfiguration."
- **Validation:** each client parses responses through the matching zod schema; a parse failure is a typed `ApiError` so malformed responses never silently produce `undefined` deep in the UI.

### 3.2 Per-backend clients

- **`api/jellyfin.ts`** ← `JellyfinApi.kt` + `buildEmbyAuthorizationHeader` (L118-124):
  - `authenticateByName({username,password})` → `POST /jellyfin/Users/AuthenticateByName` with the `X-Emby-Authorization` header (device/client/version fields ported from `buildEmbyAuthorizationHeader`). Returns `{User{Id,Name}, AccessToken, ServerId}`.
  - `getItems(userId, params)` → `GET /jellyfin/Users/{userId}/Items` (library row).
  - `getPlaybackInfo(itemId, body)` → `POST /jellyfin/Items/{itemId}/PlaybackInfo`.
  - `reportPlaying|reportProgress|reportStopped(body)` → `POST /jellyfin/Sessions/Playing|Progress|Stopped`.
  - `getResumeItems` (deferred) — signature reserved, not wired.
- **`api/jellyseerr.ts`** ← `JellyseerrApi.kt`, carrying the **language-param distinction** (do NOT centralize it — the `LanguageInterceptor.kt` footgun, explore.md L41):
  - `authJellyfin({username,password})` → `POST /jellyseerr/api/v1/auth/jellyfin`, body **only** `{username,password}` (sending host/port → 500).
  - `search(query)` and `discoverTrending()` → send `language=es-MX`.
  - `discoverMovies()` / `discoverTv()` → **omit `language` entirely** (Jellyseerr treats it as a TMDB content filter there; `es-MX` collapses results to zero). Encode this as a per-endpoint decision in the function body, never a shared interceptor.
  - `requestMedia({mediaType:'movie', mediaId})` → `POST /jellyseerr/api/v1/request`; read `response.media.status` (detail-request spec).
  - `getRequests(filter:'all')` (deferred) — reserved.
- **`api/arr.ts`** ← `ArrApi.kt` + `ArrConfig.kt` (deferred; shape only): per-call `X-Api-Key`, host-port derivation (7878/8989/9696). Design the cancel/unmonitor as **GET-raw → flip `monitored:false` → PUT-back-unmodified** so a future typed round-trip can't silently drop fields (explore.md L25). Not wired in MVP; the module exists so the pattern isn't precluded.

### 3.3 DirectPlay `<video>` auth — explicit design point to VALIDATE

`<video>` cannot send an `X-Emby-Token` header (unlike Media3). The DirectPlay URL shape is:
```
/jellyfin/Videos/{itemId}/stream{container}?static=true&mediaSourceId={id}&api_key={token}
```
**MVP decision: query-string `api_key`** — the token is appended as a query param, which Jellyfin accepts as an alternative to the header. This is the **primary live-validation target** (player spec, proposal Risks). Rationale: it lets the browser stream directly with native range requests / seeking, which a Blob approach would break (a blob buffers the whole file, killing seek and memory on large movies).

**Fallback if `api_key` query is rejected live:** `Blob + createObjectURL` (authenticated `fetch` → object URL). Documented as the escape hatch, NOT the default, precisely because it forfeits streaming/seek. The stream-URL construction is isolated in `lib/domain/streamResolver.ts` so swapping the auth strategy touches one pure function. This is called out as a spike, not an assumption (see §9).

## 4. Data layer (TanStack Query)

The native **row-isolation pattern** (`HomeViewModel.kt` independent `Result<T>` rows) maps directly onto **one `useQuery` per row**. Each row owns its own loading/error/retry state; React Query's per-query error boundaries mean a failed Trending query renders a row-scoped error while Library renders normally (home spec: row isolation). No shared "screen state" object — that is the whole point.

### 4.1 Query key design

Namespaced tuple keys, stable and serializable:
```
['jellyfin','library', userId, params]
['jellyseerr','trending']
['jellyseerr','search', debouncedQuery]
['jellyfin','item', itemId]         // detail
['jellyfin','playbackInfo', itemId]
```
Session identity is implicit (same-origin token); keys don't include the token. Logout clears the whole cache (`queryClient.clear()`).

### 4.2 Stale / cache / poll strategy

- **Rows (library, trending):** `staleTime` ~60s, `gcTime` ~5min. MVP has **no `refetchInterval`** (Continue Watching @20s and Downloading @15s are deferred). The polling seam is explicit: when those rows land, they add `refetchInterval: 20_000 / 15_000` to their own hook — nothing else changes. This is the direct analog of the native per-row poll cadence.
- **Search:** `staleTime` ~30s so re-focusing a recent query is instant; keyed on the **debounced** value so keystrokes don't spawn queries.
- **PlaybackInfo:** `staleTime: 0` (must reflect current server transcode decision each play), not retried aggressively.

### 4.3 Debounced search — `useSearch` + `useDebouncedValue` (← `SearchViewModel.kt` L106-119)

- `useDebouncedValue(raw, 350)` returns the settled value after 350ms of quiet.
- `useSearch` gates on `debounced.length >= 2` via the query's `enabled` flag — below 2 chars, no request fires (search spec). Rapid retyping resets the timer so only the final query runs.
- On success: `distinctBy(id)` via `lib/domain/dedup.ts` (`SearchRepositoryImpl.kt` L23), then join each result against library + request state through `LibraryIndex` to attach a badge.

### 4.4 Status badge — `lib/domain/libraryIndex.ts` (← `LibraryIndex.kt` L23-63)

Pure function: given (search results, Jellyfin library items, Jellyseerr request state) → per-result `InLibrary | Requesting | Requestable`.
- **Primary match:** Jellyfin `ProviderIds.Tmdb === result.id`.
- **Fallback:** title + year match when the library item lacks a TMDB id (L23-30, L49-52).
- Kept framework-free and network-free so it is directly unit-testable (§9), mirroring the pure Kotlin object.

## 5. State & auth

- **Session store — `lib/session/store.ts`** (← `CredentialStore.kt`): localStorage, **unencrypted** (Decision 4, accepted risk). Persists `{ jellyfinToken, jellyfinUserId, jellyseerrCookiePresent }`. Note: the `connect.sid` value itself lives in the browser cookie jar (same-origin), not in localStorage — we persist only a boolean/marker that onboarding completed, since the browser replays the cookie automatically. The Jellyfin token IS stored (it must ride as a header + query-string `api_key`).
- **AuthContext — `auth/AuthContext.tsx`:** exposes `{ session, login, logout }`. `login` runs the onboarding two-phase auth (§6). `logout` clears localStorage + `queryClient.clear()` + drops to onboarding. Hydrates from localStorage on boot so a reload routes straight to Home (onboarding spec: session persists across reload).
- **RouteGuard — `auth/RouteGuard.tsx`:** wraps protected routes; when `session` is absent, `<Navigate to="/onboarding" replace />`. On any 401 the http wrapper clears the session, which re-renders the guard and bounces the user.

## 6. Onboarding flow (two-phase, both-or-nothing)

Mirrors `OnboardingViewModel.kt` L44-51/L130-142 — **persist only if BOTH succeed**:
1. `authenticateByName` (Jellyfin). On failure → field-level error, **stop**, persist nothing, no Jellyseerr call.
2. `authJellyfin` (Jellyseerr) with the same credentials. On failure → error, **discard** the Jellyfin token already obtained, persist nothing.
3. Both succeed → persist token + userId + cookie marker to localStorage, route to Home.

Error routing uses the typed errors from §3.1: a `NetworkError`/`CorsError` renders the **proxy/connectivity** message (Decision 1 not satisfied); an `ApiError(401)` renders **invalid credentials**. This satisfies the onboarding spec's explicit CORS-vs-auth distinction requirement.

## 7. Routing (React Router v6)

```
/onboarding                → features/onboarding/OnboardingScreen      (public)
/                          → RouteGuard → features/home/HomeScreen     (protected)
/search                    → RouteGuard → features/search/SearchScreen  (protected)
/detail/:id                → RouteGuard → features/detail/DetailScreen   (protected)
/player/:id                → RouteGuard → features/player/PlayerScreen   (protected)
*                          → redirect to / (or /onboarding via guard)
```
`:id` is the TMDB id for detail (drives search→detail→request) and the Jellyfin item id for the player. Where a screen needs both ids, the missing one is fetched on entry rather than threaded through router state, keeping routes deep-linkable.

## 8. Theme — `src/styles/theme.css` (← `Color.kt` / `Type.kt`)

CSS custom properties on `:root`, dark-first:
```css
:root {
  --pf-bg:        #0A0C10;  /* near-black background */
  --pf-surface:   #12151B;  /* elevated cards/rails */
  --pf-gold:      #F2C14E;  /* primary accent / focus */
  --pf-available: #8CFF5A;  /* toxic-green "available"/InLibrary */
  --pf-text:      #EDEFF2;
  --pf-text-dim:  #9AA3AD;
  --pf-danger:    #E5484D;
}
```
Status badge colors map straight off these (`InLibrary`→available/green, `Requesting`→gold, `Requestable`→neutral outline). The **custom on-screen keyboard** from the native app is intentionally **not** built for MVP: the browser has a real keyboard. It is a webOS-only need (D-pad text entry) and is deferred alongside the webOS target. Note the seam: search input is a plain `<input>` now; a webOS OSK would overlay it later without changing the search hook.

## 9. Platform variants — one codebase, two distributions

**Not one artifact serving both** — two build outputs from one source (proposal §5).

- **Vite modes/env:**
  - `vite build` (mode `production`) → browser/PWA bundle, `vite-plugin-pwa` active.
  - `vite build --mode webos` (deferred) → webOS bundle with `VITE_PLATFORM=webos`, a **conservative build target** (`build.target` lowered to match old webOS Chromium; PWA plugin disabled since install-prompt is a no-op inside `.ipk`).
- **Platform shim — `lib/platform/`:** a `PlatformCapabilities` interface with `browser.ts` (active) and `webos.ts` (deferred stub). `lib/platform/index.ts` selects the impl by `import.meta.env.VITE_PLATFORM`. This is the **seam where `norigin-spatial-navigation` plugs in** (Decision 3): the webOS impl initializes spatial navigation and wires the D-pad; the browser impl is a no-op.
- **Focus-friendly components now:** `components/Focusable.tsx` and all interactive primitives are built as real focusable elements (proper `tabindex`, no mouse-only handlers) so the webOS build can later opt them into directional navigation **without restructuring** (proposal Decision 3 tradeoff). MVP does not depend on this — it just keeps the door open cheaply.

## 10. Playback — `features/player/VideoSurface.tsx` (← `PlaybackController.kt`)

- **MVP:** native `<video>` for DirectPlay only. `usePlaybackInfo` → `streamResolver`:
  - No `TranscodingUrl` → build DirectPlay URL (§3.3), set `video.src`.
  - `TranscodingUrl` present → render explicit **"not supported in this version"** state; do NOT attempt playback (player spec — no silent failure). This is the hls.js seam.
- **Resume:** seek to `resumePositionTicks → seconds` on the `canplay`/`loadedmetadata` event, only when `> 0` (player spec). For DirectPlay an initial seek is honored; the **hls.js gotcha (seek-after-ready)** is documented here as a design note for when transcode lands (`PlaybackController.kt` L96-104, L199-205) — under HLS the seek must be reapplied after the ready event, so the resume logic lives in this wrapper, not in the resolver.
- **Heartbeat — `usePlaybackHeartbeat`:** `Sessions/Playing` on start, `Sessions/Progress` on a ~10s interval, `Sessions/Stopped` on pause/unmount/navigation (player spec). Interval cleared on unmount to avoid orphaned reports.
- **hls.js seam (deferred design notes carried forward):**
  1. **Subtitle id-prefix bug** (`PlaybackController.kt` L265-275): hls.js has its own text-track id semantics; when transcode+subtitles land, match on a prefix/suffix basis, never exact `==`, or every subtitle selection silently breaks.
  2. **Resume-seek-after-ready** (above): must be re-verified against hls.js.
  Both are written down now so the future transcode work inherits the hard-won native lessons instead of rediscovering them.

## 11. Testing approach

- **Unit (`vitest`, no network, no React):** the pure domain layer — `libraryIndex.ts` (all four badge branches incl. title+year fallback), `dedup.ts` (`distinctBy` on duplicate TMDB ids), `streamResolver.ts` (TranscodingUrl → not-supported vs DirectPlay URL construction), and the debounce primitive (below-min-length, rapid-retype-resets, single-fire-on-settle). These mirror pure Kotlin logic and are the cheapest, highest-value tests.
- **Component (`@testing-library/react`):** onboarding two-phase both-or-nothing (Jellyfin-fail stops before Jellyseerr; Jellyfin-succeeds-Jellyseerr-fails discards token), route guard redirect, row isolation (mocked failing Trending query leaves Library rendered), context-aware Detail action per badge status.
- **Live / e2e spike (the primary risk, manual against the real server):** the **`<video>` DirectPlay auth** validation — does `api_key` query-string authenticate the stream without a 401, with working seek? This is the MVP's go/no-go gate for the auth+streaming path (proposal Risks, player spec). Run against the live proxied backend before building out anything downstream. If it fails, fall back to Blob (§3.3) and re-evaluate seek behavior.
- **API mappers:** zod schema tests ensure the ported DTO shapes (`JellyfinDto.kt`, `JellyseerrDto.kt`) parse representative fixtures and reject malformed payloads.

## 12. Architectural decisions (ADR-style)

**ADR-1 — Same-origin relative requests, no hostnames in client.**
*Decision:* every backend call is relative to the app origin under `/jellyfin/*` and `/jellyseerr/*`; the proxy owns routing.
*Rationale:* kills CORS preflight on `X-Emby-Token`, lets the `connect.sid` cookie replay automatically via `credentials:'include'`, keeps the app a true thin client (Decision 1).

<!--
=====================================================================
RECONSTRUCTION GAP — read this before trusting anything below this line
=====================================================================
On 2026-07-12, `npm exec create-vite@latest -- . --template react-ts
--overwrite` was run against this repo root during sdd-apply Slice 0,
and it deleted this entire `openspec/` directory (and `infra/`) because
they were untracked in git (never committed, so no git object existed
to restore from). Everything ABOVE this marker (through end of ADR-1)
is byte-verbatim, recovered from the apply agent's own tool-call
history where the file had already been read into context.

Everything BELOW this marker (ADR-2 through ADR-7, and §13 Open items)
is NOT verbatim. It is reconstructed only from a condensed engram
summary (topic `sdd/poisonflix-web/design`, project `hy300-poisonos`,
obs #947) saved during the original sdd-design phase, which paraphrased
rather than quoted the source. Treat the ADR bodies below as a
best-effort approximation of intent, not the original wording. If
byte-for-byte fidelity matters (e.g. citations, exact line-number
references into the Kotlin reference app), the safest fix is to
re-run sdd-design for this change and let it regenerate design.md
from proposal.md + specs/ fresh — PROVIDED proposal.md/explore.md/
specs/*.md are restored first (see apply-progress.md for their status,
which is worse: no verbatim or engram-summary source survives for
those files' full bodies).
=====================================================================
-->

**ADR-2 — Kotlin clean-layer mapped 1:1 into React idiom (not a UI-only port).**
*Decision:* every Kotlin data/domain/UI layer gets exactly one corresponding web layer (see §1 table): `data/remote` → `src/api`, `AuthInterceptor`/`CredentialStore` → `lib/http`/`lib/session`, `repository`/`LibraryIndex` → `lib/domain` (pure, framework-free), `*ViewModel` → TanStack Query hooks, `*Screen` → `features/*` + router.
*Rationale:* preserves the proven separation of concerns instead of re-deriving it ad hoc in a new stack; keeps domain logic (badge computation, dedup) unit-testable without React or network, mirroring the native app's pure Kotlin objects.

**ADR-3 — Row isolation via one `useQuery` per row, no aggregate screen-state object.**
*Decision:* Home's Library and Trending rows are independent `useQuery` calls, each owning its own loading/error/retry state.
*Rationale:* ports `HomeViewModel.kt`'s independent `Result<T>` rows so a failed Trending fetch never blocks or blanks a working Library row. The polling seam (deferred Continue Watching/Downloading rows) is additive — each future row just adds `refetchInterval` to its own hook.

**ADR-4 — Per-endpoint `language` param, never a shared interceptor.**
*Decision:* `search`/`discoverTrending` send `language=es-MX`; `discoverMovies`/`discoverTv` omit `language` entirely, encoded individually in each function body in `api/jellyseerr.ts`.
*Rationale:* carries forward the native `LanguageInterceptor.kt` footgun (explore.md) — centralizing this as a shared interceptor/default previously caused `discoverMovies`/`discoverTv` to silently collapse to zero results under `es-MX`. Keeping it per-call makes the divergence visible and grep-able instead of hidden in shared middleware.

**ADR-5 — Unencrypted localStorage for the Jellyfin token/session marker (accepted risk).**
*Decision:* `lib/session/store.ts` persists `{ jellyfinToken, jellyfinUserId, jellyseerrCookiePresent }` in plain localStorage; the `connect.sid` cookie itself stays in the browser's cookie jar (same-origin, not duplicated into localStorage).
*Rationale:* matches the native app's accepted personal-LAN threat model — this is a household/single-tenant deployment behind the reverse proxy, not a public multi-tenant service. Encrypting client-side storage for a token that must also ride as a query-string `api_key` buys little real security here and adds complexity; documented explicitly as an accepted risk rather than an oversight.

**ADR-6 — Platform shim seam (`lib/platform/`) built now; webOS impl deferred/stubbed.**
*Decision:* a `PlatformCapabilities` interface with an active `browser.ts` (no-op navigation, real keyboard) and a stub `webos.ts`, selected at build time via `import.meta.env.VITE_PLATFORM`. All interactive components are built focus-friendly (real `tabindex`, no mouse-only handlers) from day one.
*Rationale:* keeps the door open for `norigin-spatial-navigation` on a future webOS `.ipk` build without a later restructuring pass, at near-zero MVP cost — the browser build simply never exercises the webOS path.

**ADR-7 — Hand-rolled CSS variables, no component/UI kit.**
*Decision:* theme tokens as CSS custom properties (§8); no MUI/Chakra/etc.
*Rationale:* keeps the bundle small for the conservative webOS Chromium build target (ADR-6) and avoids relitigating a UI-kit choice later when the webOS build's stricter constraints are better understood.

## 13. Open items to validate (carry into tasks/apply)

Reconstructed from the engram summary's "Open validation items" — treat as pointers to re-derive detail from proposal.md/specs, not literal original text:

- **`<video>` DirectPlay `api_key` query-string auth, live** — the MVP's primary go/no-go spike (§3.3, §11); not yet proven against the real server. Blocking for Slice 7 (player).
- **Web codec support per actual deployment target** (browser + eventual webOS Chromium) — native codec whitelist behavior was never validated on-device; web equivalent needs its own check once playback is live.
- **Reverse-proxy path-prefix contract** (`/jellyfin/*`, `/jellyseerr/*` exactly matching `infra/Caddyfile`'s `handle_path` strip semantics) — must stay in lockstep between `vite.config.ts` dev proxy and the production Caddy config, or onboarding/API calls silently 404 in one environment and not the other.
- **webOS `build.target` floor** — the conservative Chromium version for the deferred `.ipk` build was flagged as needing confirmation before that build mode is implemented; not required for MVP browser target.
