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

## Slice 2: DirectPlay `<video>` auth spike — GO/NO-GO (do this before onboarding/home/search/detail UI work continues past stubs)

- [ ] 2.1 `src/lib/domain/streamResolver.ts` (minimal): build DirectPlay URL with `api_key` query when no `TranscodingUrl`; return not-supported marker when `TranscodingUrl` present.
- [ ] 2.2 Minimal manual harness: bare `<video>` test route pointed at a real DirectPlay URL from 2.1, run against the live proxied backend.
- [ ] 2.3 **SPIKE — GO/NO-GO**: verify live that `api_key` query-string auth loads the stream without 401 and native seeking works. Record pass/fail before proceeding to Slice 7.
- [ ] 2.4 IF FAIL: implement Blob+`createObjectURL` fallback in `streamResolver.ts`; document seek/memory tradeoff.
- [ ] 2.5 Unit tests for `streamResolver.ts` (both branches); remove the throwaway harness once resolved.

## Slice 3: Onboarding

- [ ] 3.1 `src/features/onboarding/OnboardingScreen.tsx`: 2-panel form, 4 empty fields on first load.
- [ ] 3.2 `src/auth/AuthContext.tsx`: `{session, login, logout}`; hydrate from session store on boot.
- [ ] 3.3 Two-phase login step 1: Jellyfin `authenticateByName`; on failure show field error, stop, no Jellyseerr call, persist nothing.
- [ ] 3.4 Two-phase login step 2: on Jellyfin success call Jellyseerr `authJellyfin`; on failure discard the Jellyfin token, persist nothing.
- [ ] 3.5 Both succeed: persist token+userId+cookie marker via session store, route to Home.
- [ ] 3.6 Error routing: `NetworkError`/`CorsError` -> proxy/connectivity message; `ApiError(401)` -> invalid-credentials message.
- [ ] 3.7 `src/auth/RouteGuard.tsx`: redirect unauthenticated users to `/onboarding`; wire into route tree.
- [ ] 3.8 Tests: both-or-nothing branches, route-guard redirect, reload-persists-session.

## Slice 4: Home

- [ ] 4.1 `src/hooks/useLibraryRow.ts`: `useQuery` Jellyfin `getItems`, key `['jellyfin','library',userId,params]`.
- [ ] 4.2 `src/hooks/useTrendingRow.ts`: `useQuery` Jellyseerr `discoverTrending`, key `['jellyseerr','trending']`.
- [ ] 4.3 `src/components/Row.tsx`: row-scoped loading/error/retry state.
- [ ] 4.4 `src/components/PosterCard.tsx` + `src/components/StatusBadge.tsx` (focus-friendly primitives, Decision 3 seam).
- [ ] 4.5 `src/features/home/HomeScreen.tsx`: mounts exactly Library + Trending rows.
- [ ] 4.6 Test: mocked Trending failure leaves Library rendering normally, and vice versa (row isolation).

## Slice 5: Search

- [x] 5.1 `src/hooks/useDebouncedValue.ts`: 350ms debounce primitive. **Done in Slice 1** (pulled forward, see note there) — do not redo.
- [ ] 5.2 `src/lib/domain/dedup.ts`: `distinctBy(id)`.
- [x] 5.3 `src/lib/domain/libraryIndex.ts`: badge resolver — TMDB id match + title+year fallback -> `InLibrary|Requesting|Requestable`. **Done in Slice 1** (pulled forward, see note there) — do not redo.
- [ ] 5.4 `src/hooks/useSearch.ts`: `enabled` gated on length>=2 of debounced value, dedup + badge join, `staleTime` ~30s.
- [ ] 5.5 `src/features/search/SearchScreen.tsx`: input + results carousel + large preview panel.
- [ ] 5.6 Unit tests: debounce (below-min, rapid-retype, single-fire-on-settle), `dedup.ts`, `libraryIndex.ts` (all 4 branches).
- [ ] 5.7 Component test: selecting a carousel result updates the preview.

## Slice 6: Detail + Request

- [ ] 6.1 `src/hooks/useMovieDetail.ts`: fetch + badge, key `['jellyfin','item',itemId]`.
- [ ] 6.2 `src/hooks/useRequestMedia.ts`: `useMutation` -> `POST api/v1/request` `{mediaType:'movie', mediaId}`.
- [ ] 6.3 `src/features/detail/DetailScreen.tsx`: context-aware action — `Requestable`=enabled Pedir, `Requesting`=disabled, `InLibrary`=no action.
- [ ] 6.4 Wire success: reflect `response.media.status` (not an assumed local status).
- [ ] 6.5 Wire failure: show error, action reverts to pre-submission enabled state, no optimistic change.
- [ ] 6.6 Component test: all 3 badge branches + success/failure status reflection.

## Slice 7: Player (builds on Slice 2's validated spike)

- [ ] 7.1 `src/hooks/usePlaybackInfo.ts`: PlaybackInfo -> resolved source via the validated `streamResolver.ts`, `staleTime: 0`.
- [ ] 7.2 `src/features/player/VideoSurface.tsx`: `<video>` wrapper; DirectPlay sets `src`; `TranscodingUrl` present -> explicit "not supported in this version" state, no playback attempt.
- [ ] 7.3 Resume: seek on `canplay`/`loadedmetadata` when resume position > 0; no seek at 0/absent.
- [ ] 7.4 `src/hooks/usePlaybackHeartbeat.ts`: `Sessions/Playing` on start, `Sessions/Progress` ~10s interval, `Sessions/Stopped` on pause/unmount/navigation; interval cleared on unmount.
- [ ] 7.5 `src/features/player/PlayerScreen.tsx`: wires info+surface+heartbeat; surfaces a clear playback-auth error on 401/403 instead of a silent black screen.
- [ ] 7.6 Code comment in `VideoSurface.tsx` carrying forward the two hls.js gotchas (subtitle id-prefix match, resume-seek-after-ready) as design notes only — no implementation.
- [ ] 7.7 Tests: DirectPlay src set correctly from mocked PlaybackInfo; transcode-only movie shows not-supported state without attempting playback.

## Deferred (explicitly NOT tasks in this MVP)

- webOS `.ipk` build + `norigin-spatial-navigation` wiring (`lib/platform/webos.ts` stays a stub).
- PWA offline caching / install prompt (plugin present, inactive).
- hls.js transcode playback + audio/subtitle track switching.
- Continue Watching / Downloading polling rows (`Items/Resume`, Jellyseerr request-list poll).
- +18 PIN gate.
- 10 genre/category rows.
- TV/series episodes two-pane + season logic.
- Delete/cancel-download flows (`api/arr.ts` stays shape-only, unwired).

## Prerequisite (infra, not app code)

- [ ] P.1 Stand up the reverse proxy (Decision 1) so `/`, `/jellyfin/*`, `/jellyseerr/*` are same-origin BEFORE attempting to test onboarding end-to-end. Owned by the LAN user, outside this repo, but blocking for any live verification beyond Slice 0.
