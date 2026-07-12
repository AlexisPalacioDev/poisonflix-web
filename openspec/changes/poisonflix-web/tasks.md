# Tasks: poisonflix-web

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~3000-4500 (greenfield scaffold, 8 slices, no existing code to diff against) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR0 scaffold -> PR1 api/auth -> PR2 DirectPlay spike -> PR3 onboarding -> PR4 home -> PR5 search -> PR6 detail+request -> PR7 player |
| Delivery strategy | ask-on-risk (default; not overridden by this delegation) |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 0 | Repo scaffold, routing/theme shell, dev-proxy | PR0 | No backend calls yet; safe standalone review |
| 1 | Typed API clients + auth/session layer | PR1 | Depends on PR0; no UI wiring beyond stubs |
| 2 | DirectPlay auth GO/NO-GO spike | PR2 | Depends on PR1; throwaway harness removed before merge |
| 3 | Onboarding screen + AuthContext + RouteGuard | PR3 | Depends on PR1; first screen to actually authenticate |
| 4 | Home (Library+Trending rows, row isolation) | PR4 | Depends on PR3 (session) |
| 5 | Search (debounce, dedup, LibraryIndex badge) | PR5 | Depends on PR4's badge/component base |
| 6 | Detail + request flow | PR6 | Depends on PR5's LibraryIndex |
| 7 | Player (uses validated spike from PR2) | PR7 | Depends on PR2 result (GO or Blob fallback) |

## Slice 0: Repo scaffolding

- [x] 0.1 Init Vite+React+TS project (`package.json`, `tsconfig.json`, `index.html`).
- [x] 0.2 Install deps: `react-router-dom`, `@tanstack/react-query`, `zod`, `vite-plugin-pwa`, `vitest`, `@testing-library/react`.
- [x] 0.3 Create folder tree per design.md §2: `src/api/schemas`, `src/lib/{http,session,domain,platform}`, `src/hooks`, `src/features/{onboarding,home,search,detail,player}`, `src/components`, `src/auth`, `src/routes`, `src/styles`.
- [x] 0.4 `vite.config.ts`: PWA plugin present but inactive for MVP + dev `server.proxy` mapping `/jellyfin` and `/jellyseerr` to local backends (mirrors the reverse-proxy contract for local dev).
- [x] 0.5 `.env.development`/`.env.production`: `VITE_JELLYFIN_BASE=/jellyfin`, `VITE_JELLYSEERR_BASE=/jellyseerr`; `.env.webos` stub only.
- [x] 0.6 `src/styles/theme.css` (CSS vars per design.md §8) + `src/styles/global.css`.
- [x] 0.7 `src/main.tsx` (QueryClientProvider + AuthProvider + RouterProvider) + `src/routes/index.tsx` route-tree stubs (design.md §7).
- [x] 0.8 **README**: document reverse proxy as a BLOCKING infra prerequisite (Decision 1 — `/jellyfin/*`/`/jellyseerr/*` same-origin routing must exist before onboarding works) + local dev-proxy usage.
- [x] 0.9 `vitest` config + smoke test (app renders without crashing).

## Slice 1: API client + auth layer — COMPLETE

- [x] 1.1 `src/api/schemas/jellyfin.ts`: zod schemas (User/AccessToken/PlaybackInfo).
- [x] 1.2 `src/api/schemas/jellyseerr.ts`: zod schemas (search/discover/request incl. `media.status`).
- [x] 1.3 `src/lib/http/errors.ts`: `ApiError` vs `NetworkError`/`CorsError` distinction.
- [x] 1.4 `src/lib/session/store.ts`: localStorage read/write/clear.
- [x] 1.5 `src/lib/http/client.ts`: `apiFetch` — inject `X-Emby-Token` (Jellyfin), `credentials:'include'` (Jellyseerr), 401 clears session with no retry, schema-validated parse.
- [x] 1.6 `src/api/jellyfin.ts`: `authenticateByName`, `getItems`, `getPlaybackInfo`, `reportPlaying/reportProgress/reportStopped`; `getResumeItems` signature reserved only (deferred).
- [x] 1.7 `src/api/jellyseerr.ts`: `authJellyfin` (body-only `{username,password}`), `search`/`discoverTrending` (`language=es-MX`), `discoverMovies`/`discoverTv` (omit `language`, per-endpoint — ADR-4), `requestMedia`; `getRequests` reserved (deferred).
- [x] 1.8 `src/api/arr.ts` + `src/lib/domain/config.ts`: shape only, not wired into any UI (deferred surface).
- [x] 1.9 Unit tests: `errors.ts` distinction; schema fixtures parse valid / reject malformed payloads.

Pulled forward from Slice 5 into this batch (pure, framework-free, no UI dependency — flagged deviation, not silent):
- [x] 5.3 `src/lib/domain/libraryIndex.ts`: badge resolver — TMDB id match + title+year fallback -> `InLibrary|Requesting|Requestable` (unit tests: all 4 branches incl. primary-vs-fallback precedence).
- [x] 5.1 (partial) `src/hooks/useDebouncedValue.ts`: 350ms debounce primitive (unit tests: below-min, rapid-retype, single-fire-on-settle). `useSearch.ts`'s `enabled` gating itself is still Slice 5 work.
- Also added (not separately tracked tasks, foundational per delegation §5): `src/hooks/queryKeys.ts` (query-key factory) and `src/hooks/useAuth.ts` (thin re-export of `useAuthContext`).

## Slice 2: DirectPlay `<video>` auth spike — GO/NO-GO — COMPLETE (GO)

- [x] 2.1 `src/lib/domain/streamResolver.ts` (minimal): build DirectPlay URL with `api_key` query when no `TranscodingUrl`; return not-supported marker when `TranscodingUrl` present.
- [x] 2.2 Minimal manual harness: no `<video>` DOM route was needed — validated directly via `curl` against the live proxied backend (identical GET + Range semantics to what `<video>` issues), per this batch's delegation. No throwaway route/script committed.
- [x] 2.3 **SPIKE — GO/NO-GO: GO.** Verified live that `api_key` query-string auth loads the stream without a 401 and native range-request seeking works (200/206, `Content-Type: video/mp4`, real MP4 bytes at offset 0 and mid-file). See apply-progress.md Slice 2 section for full evidence.
- [ ] 2.4 Not needed — GO verdict. Blob fallback stays deferred/undesigned per player spec's Deferred section.
- [x] 2.5 Unit tests for `streamResolver.ts` (both branches, plus resume ticks->ms) — `src/lib/domain/streamResolver.test.ts`, 12 tests, all passing. No throwaway harness existed to remove.

## Slice 3: Onboarding

- [x] 3.1 `src/features/onboarding/OnboardingScreen.tsx`: 2-panel form. **Deviation from the literal spec** (approved by this batch's delegation): only username+password are user-entered fields; the Jellyfin/Jellyseerr URLs are the fixed same-origin proxy prefixes (`/jellyfin`, `/jellyseerr`), shown read-only under a "Configuración avanzada" `<details>` disclosure instead of as required inputs, since this web app is same-origin via the reverse proxy (unlike the native app's absolute-IP model).
- [x] 3.2 `src/auth/AuthContext.tsx`: `{session, login, logout}`; hydrates from `lib/session/store.ts` on boot; `logout` clears storage + `queryClient.clear()`.
- [x] 3.3 Two-phase login step 1: Jellyfin `authenticateByName` (`lib/domain/onboardingAuth.ts`); on failure throws `OnboardingAuthError('jellyfin', cause)`, no Jellyseerr call, persists nothing.
- [x] 3.4 Two-phase login step 2: on Jellyfin success calls Jellyseerr `authJellyfin`; on failure throws `OnboardingAuthError('jellyseerr', cause)` - the Jellyfin token obtained in step 1 is discarded simply by never being returned/persisted.
- [x] 3.5 Both succeed: persist token+userId+serverId+cookie marker via session store (`AuthContext.login`), navigate to `/`.
- [x] 3.6 Error routing (`features/onboarding/errorMessage.ts`): `NetworkError`/`CorsError` -> proxy/connectivity message naming the failed backend; `ApiError(401)` -> invalid-credentials message, distinct per backend.
- [x] 3.7 `src/auth/RouteGuard.tsx`: redirect unauthenticated users to `/onboarding`; **added `PublicOnlyRoute`** (inverse guard) so an already-authenticated user is redirected away from `/onboarding` to `/`; both wired into `routes/index.tsx`.
- [x] 3.8 Tests: `lib/domain/onboardingAuth.test.ts` (both-or-nothing branches), `features/onboarding/errorMessage.test.ts` (error mapping), `features/onboarding/OnboardingScreen.test.tsx` (component-level happy/failure paths + advanced disclosure), `auth/RouteGuard.test.tsx` (route-guard redirect + reload-persists-session). 22 new tests, all passing.

## Slice 4: Home — COMPLETE

- [x] 4.1 `src/hooks/useLibraryRow.ts`: `useQuery` Jellyfin `getItems`, key `['jellyfin','library',userId,params]`.
- [x] 4.2 `src/hooks/useTrendingRow.ts`: `useQuery` Jellyseerr `discoverTrending`, key `['jellyseerr','trending']`.
- [x] 4.3 `src/components/Row.tsx`: row-scoped loading/error/retry state.
- [x] 4.4 `src/components/PosterCard.tsx` + `src/components/StatusBadge.tsx` (focus-friendly primitives, Decision 3 seam).
- [x] 4.5 `src/features/home/HomeScreen.tsx`: mounts exactly Library + Trending rows.
- [x] 4.6 Test: mocked Trending failure leaves Library rendering normally, and vice versa (row isolation).

## Slice 5: Search — COMPLETE

- [x] 5.1 `src/hooks/useDebouncedValue.ts`: 350ms debounce primitive. **Done in Slice 1** (pulled forward, see note there) — do not redo.
- [x] 5.2 `src/lib/domain/dedup.ts`: `distinctBy(id)`.
- [x] 5.3 `src/lib/domain/libraryIndex.ts`: badge resolver — TMDB id match + title+year fallback -> `InLibrary|Requesting|Requestable`. **Done in Slice 1** (pulled forward, see note there) — do not redo.
- [x] 5.4 `src/hooks/useSearch.ts`: `enabled` gated on length>=2 of debounced value, dedup + badge join, `staleTime` ~30s. Reuses `useLibraryRow()` (same query key as Home) to build the `LibraryIndex` instead of issuing a second Jellyfin fetch.
- [x] 5.5 `src/features/search/SearchScreen.tsx`: input + results carousel (reuses `Row`/`PosterCard`) + big preview panel (`BigPreview`, title/year/rating/overview/badge). Auto-selects the first result once results load, mirroring `SearchViewModel.kt`. Clicking a poster navigates to `/detail/:id` (Slice 6 placeholder); focus/hover on a poster selects it for the preview without navigating (extended `PosterCard` with an optional `onFocus` callback, additive — Home's usage unaffected).
- [x] 5.6 Unit tests: debounce (already covered in Slice 1), `dedup.ts` (3 tests: collapse duplicates, empty array, already-unique passthrough), `libraryIndex.ts` (already covered in Slice 1, all 4 branches).
- [x] 5.7 Component test: `SearchScreen.test.tsx` — below-2-chars empty state (no request, no error), debounce+dedup+badge join with real component rendering, and selecting a different carousel result (via focus) updates the big preview.

**Bug found + fixed during live validation:** `api/jellyseerr.ts`'s `search()` built its query string via `URLSearchParams`, which encodes spaces as `+`. Jellyseerr's `/api/v1/search` endpoint strictly rejects that (`400 "Parameter 'query' must be url encoded"`) — confirmed live via curl against the real backend. Fixed by percent-encoding the `query` param with `encodeURIComponent` directly instead of folding it into `URLSearchParams`, keeping `page`/`language` on `URLSearchParams` since those never contain spaces. This was invisible until Search because `discover/trending`'s params never contain spaces.

## Slice 6: Detail + Request — COMPLETE

- [x] 6.1 `src/hooks/useMovieDetail.ts`: fetch + badge, key `['jellyfin','item',itemId]`.
- [x] 6.2 `src/hooks/useRequestMedia.ts`: `useMutation` -> `POST api/v1/request` `{mediaType:'movie', mediaId}`.
- [x] 6.3 `src/features/detail/DetailScreen.tsx`: context-aware action — `Requestable`=enabled Pedir, `Requesting`=disabled, `InLibrary`=no action (shows "Reproducir" instead, per this batch's explicit task scope).
- [x] 6.4 Wire success: reflect `response.media.status` (not an assumed local status).
- [x] 6.5 Wire failure: show error, action reverts to pre-submission enabled state, no optimistic change.
- [x] 6.6 Component test: all 3 badge branches + success/failure status reflection.

## Slice 7: Player (builds on Slice 2's validated spike) — COMPLETE

- [x] 7.1 `src/hooks/usePlaybackInfo.ts`: PlaybackInfo -> resolved source via the validated `streamResolver.ts`, `staleTime: 0`.
- [x] 7.2 `src/features/player/VideoSurface.tsx`: `<video>` wrapper; DirectPlay sets `src`; `TranscodingUrl` present -> explicit "not supported in this version" state, no playback attempt.
- [x] 7.3 Resume: seek on `canplay`/`loadedmetadata` when resume position > 0; no seek at 0/absent.
- [x] 7.4 `src/hooks/usePlaybackHeartbeat.ts`: `Sessions/Playing` on start, `Sessions/Progress` ~10s interval, `Sessions/Stopped` on pause/unmount/navigation; interval cleared on unmount.
- [x] 7.5 `src/features/player/PlayerScreen.tsx`: wires info+surface+heartbeat; surfaces a clear playback-auth error on 401/403 instead of a silent black screen.
- [x] 7.6 Code comment in `VideoSurface.tsx` carrying forward the two hls.js gotchas (subtitle id-prefix match, resume-seek-after-ready) as design notes only — no implementation.
- [x] 7.7 Tests: DirectPlay src set correctly from mocked PlaybackInfo; transcode-only movie shows not-supported state without attempting playback.

**MVP COMPLETE** — all 8 slices (0-7) implemented and live-validated. See apply-progress.md's Slice 7 section for full evidence (real playback, readyState/currentTime/videoWidth numbers, heartbeat cadence confirmed at exactly 10,000ms).

## Slice 8: HLS transcode playback (post-MVP fix) — COMPLETE

Un-deferred from the list below: the MVP shipped DirectPlay-only, which
silently failed to play any HEVC/EAC3/MKV title (confirmed live: The Matrix,
itemId `57464bb8693566f4b95737a0ea361154`, `video.canPlayType('...hvc1...')`
returns `""`). Root cause was a `DeviceProfile: null` on every `PlaybackInfo`
request, which made Jellyfin assume DirectPlay was always safe.

- [x] 8.1 `src/lib/domain/deviceProfile.ts`: `createBrowserDeviceProfile()`, ported from the native `DeviceProfileFactory.kt` - narrow H.264/AAC/mp4 `DirectPlayProfiles` + an HLS (`ts`, h264/aac) `TranscodingProfile`.
- [x] 8.2 `usePlaybackInfo.ts` wires the real device profile into every `getPlaybackInfo` call (was `null`).
- [x] 8.3 `streamResolver.ts` confirmed correct as-is: `TranscodingUrl` -> `Transcoded(hlsUrl)`, joined onto the same-origin `/jellyfin` base with the token Jellyfin embeds in the URL - no change needed.
- [x] 8.4 `VideoSurface.tsx`: handles both `PlaybackSource` variants - DirectPlay unchanged; Transcoded uses `hls.js` (`Hls.isSupported()`), falls back to native HLS (`video.canPlayType('application/vnd.apple.mpegurl')`, Safari), and surfaces a genuinely-rare `onUnsupported` case otherwise. Resume-seek gotcha carried forward correctly: HLS seeks on `MANIFEST_PARSED`/`canplay`, never on `loadedmetadata` (that stays DirectPlay-only).
- [x] 8.5 `PlayerScreen.tsx`: removed the old "not supported in this version" branch (replaced by real playback); distinguishes a real 401 on the `PlaybackInfo` fetch (session message) from any other fetch failure (load message) from a mid-playback `<video>`/hls.js fatal error (playback message) from the rare unsupported-browser case.
- [x] 8.6 Unit tests: `deviceProfile.test.ts` (profile shape, no HEVC/EAC3/AC3/DTS whitelisted), `VideoSurface.test.tsx` (hls.js load + destroy-on-unmount/source-change + fatal-error + unsupported-browser branches, resume-seek-timing guard), `PlayerScreen.test.tsx` (Transcoded now plays instead of refusing, 401-vs-generic error message distinction).
- [x] 8.7 **Live verification (agent-browser, MANDATORY)**: The Matrix (HEVC) genuinely plays via transcoded HLS - `readyState:4`, real `1920x800` decoded frames, `currentTime` advancing, real HLS manifest/segment requests all `200` through the `/jellyfin` proxy, screenshot of a real decoded frame. Night of the Living Dead (H.264) still DirectPlays with no regression. Re-verified identically against the production Caddy proxy at `:8600` after rebuild+redeploy. See apply-progress.md's Slice 8 section for full evidence.

## Deferred (explicitly NOT tasks in this MVP)

- webOS `.ipk` build + `norigin-spatial-navigation` wiring (`lib/platform/webos.ts` stays a stub).
- PWA offline caching / install prompt (plugin present, inactive).
- Audio/subtitle track switching (transcode playback itself is no longer deferred - see Slice 8).
- Continue Watching / Downloading polling rows (`Items/Resume`, Jellyseerr request-list poll).
- +18 PIN gate.
- 10 genre/category rows.
- TV/series episodes two-pane + season logic.
- Delete/cancel-download flows (`api/arr.ts` stays shape-only, unwired).

## Prerequisite (infra, not app code)

- [ ] P.1 Stand up the reverse proxy (Decision 1) so `/`, `/jellyfin/*`, `/jellyseerr/*` are same-origin BEFORE attempting to test onboarding end-to-end. Owned by the LAN user, outside this repo, but blocking for any live verification beyond Slice 0.
