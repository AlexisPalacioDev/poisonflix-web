# Proposal: poisonflix-web

Status: proposed
Change: `poisonflix-web`
Reads: explore.md (optional)
Feeds: `sdd-spec`, `sdd-design` (can run in parallel)
Reference app: `/home/alexis/Documentos/poisonflix` (Kotlin Compose-for-TV, `com.hy300.poisonflix`)

## 1. Intent

Build **poisonflix-web**, a new React + Vite + TypeScript PWA that is a *thin client* over the exact same self-hosted backend the existing Kotlin Android TV app already uses (Jellyfin for auth/media/playback, Jellyseerr for TMDB search/discover/request, and the Radarr/Sonarr/Prowlarr *arr stack). One web codebase is designed to target three distributions from a single source: a desktop browser, a mobile-installable PWA, and a future webOS `.ipk` for LG TVs. The Kotlin app remains the projector client and is out of scope; the backend APIs are unchanged. The problem this solves *now* is reach — the household's media stack is currently only reachable through a TV-form-factor native app, and we want the same curated experience (onboarding, browse, search, request, play) on phones and browsers without a second parallel implementation or a new server tier. Success for this change means an MVP where a user can onboard against the real proxied backend, see their library and trending rows, search for a movie, request it, and DirectPlay it in a `<video>` element — proving the highest-risk paths (same-origin proxy auth and header-less `<video>` streaming) before we invest in the deferred surface.

## 2. Scope

### In scope (MVP)
- **Onboarding**: two-panel form, two-phase both-or-nothing auth (Jellyfin then Jellyseerr), session persisted across reload.
- **Home**: library row (Jellyfin) + trending row (Jellyseerr), each an isolated query with its own loading/error/retry.
- **Search + Detail (movies-only)**: debounced search, TMDB dedup, unified status badge (InLibrary / Requesting / Requestable), context-aware "Pedir" action, request via Jellyseerr.
- **Player (DirectPlay-first)**: native `<video>` DirectPlay via Jellyfin, resume seek, playback heartbeat (Playing/Progress/Stopped).
- **Browser target** only for MVP delivery.

### Out of scope
- **Kotlin Android TV app** — untouched; stays the projector client.
- **Backend changes** — Jellyfin / Jellyseerr / *arr APIs are consumed as-is, no server-side modification.
- **Reverse proxy** — it is an *infrastructure prerequisite*, not app code. It is **already stood up and validated** via **Caddy in `infra/`** (app + both backends same-origin at `:8600`, `/jellyfin` and `/jellyseerr` prefixes stripped).

### Deferred (post-MVP, seams kept open)
Continue Watching / Downloading polling rows, the 10 genre/category rows, +18 PIN gate, TV/series episodes (two-pane season logic), HLS transcode + audio/subtitle track switching, delete/cancel-download (*arr* flows), webOS `.ipk` packaging + spatial navigation, and PWA offline caching / install prompt.

## 3. Approach

poisonflix-web preserves the Kotlin clean-layer separation **1:1** in a React idiom rather than re-deriving architecture ad hoc. Each Kotlin layer maps to exactly one web layer, and that mapping is the organizing principle of the codebase.

- **API client layer** ← `data/remote/*Api.kt` + `dto/*Dto.kt` + `AuthInterceptor.kt`.
  Typed fetch clients (`src/api/`) with zod schemas mirror `JellyfinApi.kt` / `JellyseerrApi.kt`. A single `apiFetch` wrapper (`src/lib/http/client.ts`) replaces the two OkHttp interceptors: it injects `X-Emby-Token` for Jellyfin, sends `credentials:'include'` so the browser replays the same-origin `connect.sid` cookie automatically (the manual `Cookie` header is *gone*), and clears the session with no retry on 401 — mirroring `AuthInterceptor.kt`. The `buildEmbyAuthorizationHeader` device fields port directly into `authenticateByName`.

- **Data / hooks layer** ← `ui/*ViewModel.kt`.
  TanStack Query hooks (`src/hooks/`) mirror `HomeViewModel`'s **row-isolation** pattern: one `useQuery` per row, each owning its own state, so a failed Trending fetch never blanks a working Library row. The native per-row `refetchInterval` cadence (Continue Watching @20s, Downloading @15s) is a deferred, additive seam — a future row just adds `refetchInterval` to its own hook, nothing else changes. Search debounce (350ms / min 2 chars) and TMDB `distinctBy(id)` dedup carry over as `useDebouncedValue` + a pure `dedup` helper.

- **Domain layer** ← `data/repository/*Impl.kt` + `LibraryIndex.kt`.
  Pure, framework-free, network-free functions (`src/lib/domain/`) for badge resolution (`libraryIndex.ts`: TMDB-id primary match, title+year fallback), dedup, and stream URL construction — directly unit-testable, mirroring the pure Kotlin objects.

- **Screen tree + routing** ← `ui/<screen>Screen.kt` + `ui/navigation/*`.
  Onboarding → Home → Search → Detail → Player as feature folders (`src/features/`) wired through React Router v6, with an `AuthContext` + `RouteGuard` bouncing unauthenticated users to `/onboarding`. Routes are deep-linkable (`:id` is TMDB id for detail, Jellyfin item id for player).

- **Player** ← `player/StreamResolver.kt` + `player/PlaybackController.kt`.
  `usePlaybackInfo` → `streamResolver` builds the DirectPlay URL (`Videos/{itemId}/stream{ext}?static=true&mediaSourceId=...`); a present `TranscodingUrl` renders an explicit "not supported in this version" state (the hls.js seam) rather than failing silently. Resume seeks on `canplay`/`loadedmetadata` when position > 0. The header-less `<video>` constraint forces a DirectPlay auth strategy (see Decision-adjacent Risks). hls.js and its ported gotchas (subtitle id-prefix match, resume-seek-after-ready) are written down as design notes for the deferred transcode work.

- **Platform variants** ← the "one codebase, two distributions" seam.
  A `PlatformCapabilities` shim (`src/lib/platform/`) selects `browser.ts` (active) vs a stubbed `webos.ts` by `import.meta.env.VITE_PLATFORM`. All interactive primitives are built focus-friendly (real `tabindex`, no mouse-only handlers) so the future webOS build can opt into spatial navigation without restructuring. `vite-plugin-pwa` is present for the browser/PWA build and disabled for the webOS mode.

## 4. Decisions

### Decision 1 — CORS strategy: reverse proxy, same-origin path routing. **GO.**
**Verdict:** Adopt a reverse proxy that makes the app, Jellyfin, and Jellyseerr share **one origin** under path prefixes (`/jellyfin/*`, `/jellyseerr/*`). The client only ever issues **relative** requests; no hostnames live in the client. This is an infrastructure prerequisite the LAN owner stands up — and it is **already DONE**: Caddy is deployed and validated in `infra/`, serving app + both backends same-origin at `:8600`, with the `/jellyfin` and `/jellyseerr` prefixes stripped before proxying.
**Rationale:** CORS is the single biggest *new* problem class versus the native app (which has zero CORS exposure). Same-origin eliminates the preflight burden on the custom `X-Emby-Token` header, and — critically — solves the Jellyseerr cookie problem: a cross-origin `connect.sid` would need `SameSite=None; Secure` (HTTPS) to survive and would otherwise be silently dropped; same-origin lets the browser replay it automatically via `credentials:'include'`.
**Tradeoffs:** Introduces an infra dependency the app cannot function without (mitigated: already deployed, and README documents it as blocking). The client and the Caddy config must keep their path-prefix contract in lockstep (carried as a Risk).
**Rejected alternatives:** (a) *per-backend CORS config* on Jellyfin/Jellyseerr — brittle across two servers, still leaves the cookie `SameSite` problem; (b) *a thin backend/edge tier* — directly contradicts the "thin client" goal and adds a server tier we explicitly do not want.

### Decision 2 — MVP scope: movies-first, DirectPlay-first, browser-first. **GO.**
**Verdict:** Ship the smallest slice that proves the risky paths end-to-end. **IN:** onboarding, home (library + trending rows only), search + movie detail + request, and `<video>` DirectPlay. **DEFERRED:** Continue Watching / Downloading polling, the 10 genre rows, +18 PIN, TV episodes, HLS transcode + tracks, delete/cancel, webOS `.ipk`, and PWA offline.
**Rationale:** The unknowns are the same-origin proxy auth and header-less `<video>` streaming — everything else is a known port of proven Kotlin logic. Sequencing to validate DirectPlay `<video>` + auth *before* investing in hls.js/transcode de-risks the whole effort. Movies-only sidesteps the TV two-pane season/episode complexity for now.
**Tradeoffs:** The first usable build is intentionally incomplete versus the native app (no polling rows, no PIN, no TV). Accepted: seams (additive `refetchInterval`, unwired `api/arr.ts`, stubbed webOS platform) are kept open so deferred work is additive, not a rewrite.

### Decision 3 — webOS spatial-navigation: `norigin-spatial-navigation` behind a platform shim, webOS-build only. **GO (deferred).**
**Verdict:** For the future webOS `.ipk` target, use `norigin-spatial-navigation` (D-pad directional nav) wired **only** in the webOS build via the platform shim — **not** full LG Enact, and not in the MVP.
**Rationale:** LG remotes are D-pad-first, so the native "focus-loss" problem class returns for that one target (and only that target — it is genuinely N/A for browser/mobile). A standalone spatial-nav library scoped behind `lib/platform/webos.ts` gives us that behavior without adopting Enact's full framework and relitigating the decided React stack. Building all interactive components focus-friendly *now* (proper `tabindex`, no mouse-only handlers) keeps the door open at near-zero MVP cost.
**Tradeoffs:** We pay a small, ongoing discipline tax (every interactive primitive must stay focusable) for a target we are not shipping yet. Accepted because retrofitting focusability later would be a costly restructuring pass. Architecture must keep focusable primitives so webOS is not precluded.
**Rejected alternative:** *Full Enact* — heavier runtime, reopens the framework choice, overkill for D-pad nav alone.

### Decision 4 — Auth-token storage: accept unencrypted localStorage/IndexedDB exposure. **GO (explicit risk acceptance).**
**Verdict:** Persist the Jellyfin token + userId + a Jellyseerr cookie-present marker in plain `localStorage`, unencrypted. There is no browser equivalent of Android Keystore, and the token must also ride as a query-string `api_key` for `<video>` DirectPlay, so client-side encryption buys little.
**Rationale:** This matches the native app's already-documented **personal-LAN threat model** — a household / single-tenant deployment behind the reverse proxy, not a public multi-tenant service. The realistic XSS-exposure risk is accepted explicitly rather than papered over with complexity that adds no real security here. Note the `connect.sid` value itself stays in the browser's same-origin cookie jar, not duplicated into localStorage.
**Tradeoffs:** localStorage is XSS-readable; a successful script injection could exfiltrate the token. Accepted for this deployment class, documented as a conscious decision, not an oversight.

## 5. Prerequisites & dependencies

- **Reverse proxy (Decision 1) — DONE.** Caddy in `infra/` provides same-origin `/`, `/jellyfin/*`, `/jellyseerr/*` at `:8600` with prefix-strip. Blocking for any live verification beyond scaffolding; already validated. The dev-time Vite `server.proxy` must mirror this contract for local development.
- **Node toolchain** — Node + npm for Vite 5 / React 18 / TypeScript (strict); dependencies: `@tanstack/react-query` v5, `react-router-dom` v6, `zod`, `vite-plugin-pwa`, `vitest` + `@testing-library/react`. No component/UI kit (hand-rolled CSS variables to keep the bundle small for the conservative webOS target).
- **webOS CLI / `ares` tooling — deferred.** Needed only when the `.ipk` build mode lands (Decision 3); not required for the MVP browser target.

## 6. Risks (carried from exploration)

- **CORS / proxy path-prefix contract.** The client's `/jellyfin/*` and `/jellyseerr/*` prefixes must match the Caddy `handle_path` strip semantics *and* the Vite dev-proxy exactly. A drift silently 404s onboarding/API calls in one environment but not the other. Keep `vite.config.ts` and the Caddyfile in lockstep.
- **`<video>` DirectPlay auth — the MVP's primary validation target.** `<video>` cannot send a custom `X-Emby-Token` header (unlike Media3). MVP strategy: append the token as a Jellyfin **`api_key` query-string** parameter on the DirectPlay URL (native range requests + seeking preserved). This is **unverified live** and is the go/no-go spike before building the player. Fallback if rejected live: `Blob + createObjectURL` — documented as the escape hatch, *not* the default, because a blob buffers the whole file and forfeits seek/memory on large movies. The URL construction is isolated in one pure function so swapping strategy touches one place.
- **Codec whitelist not device-confirmed.** The native H.264/AAC-only direct-play profile was *never* device-validated even on Android; only the *pattern* (conservative direct-play + server transcode fallback) transfers, not the actual codec table. Web codec support needs its own per-target investigation (browser vs eventual webOS Chromium) once playback is live.
- **Language-param footgun.** Jellyseerr treats `language` on `/discover/movies|tv` as a TMDB *content filter*, not a locale; `es-MX` (not ISO-639-1) collapsed results to zero natively. Port the *distinction*: send `language=es-MX` on `search`/`discoverTrending`, but **omit `language` entirely** on `discoverMovies`/`discoverTv`, encoded per-endpoint — never as a shared interceptor (the original `LanguageInterceptor.kt` mistake).
- **Deferred hls.js gotchas (design notes carried forward).** When transcode lands: (1) **resume-seek-after-ready** — DirectPlay honors an initial seek but HLS does not, so the seek must be reapplied after the ready event (lives in the `<video>` wrapper, not the resolver); (2) **subtitle `Format.id` prefix match** — HLS prefixes sideloaded subtitle ids (`"11:sub-12"` vs `"sub-12"`), so exact `==` silently breaks every subtitle selection; hls.js has its own text-track id semantics and must be matched on prefix/suffix, never exact equality.
