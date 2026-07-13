# Tasks: availability-preview

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~600 (new domain/hooks/UI + proxy config + TV extension) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes (2 slices are independently reviewable) |
| Suggested split | PR1 availability-preview (movies) → PR2 tv-detail slice |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No (retroactive — already implemented and verified)
Status: implemented; all items landed and verified (150/150 tests, `tsc -b` clean, live proxy E2E)

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Availability preview (Prowlarr proxy + domain + panel), movies | PR1 | Self-contained; no TV dependency |
| 2 | TV detail slice (media-agnostic detail + nav `?type=`) | PR2 | Makes the panel reachable for series |

## Slice 1: Availability preview (movies)

- [x] 1.1 Add `/prowlarr` same-origin proxy — Vite `server.proxy` with server-side `X-Api-Key` injection from `PROWLARR_API_KEY`.
- [x] 1.2 Mirror it in `infra/Caddyfile` (`handle_path /prowlarr/*` + `header_up X-Api-Key {$PROWLARR_API_KEY}`) and pass the env in `infra/docker-compose.yml`.
- [x] 1.3 Add `prowlarr` to `Backend` + `BASE_URLS` in `src/lib/http/client.ts`; attach no browser credential for it.
- [x] 1.4 `src/api/schemas/prowlarr.ts` — defensive Zod schema (passthrough; `languages` intentionally omitted).
- [x] 1.5 `src/api/prowlarr.ts` — `searchReleases(query)` (`encodeURIComponent`, `type=search`).
- [x] 1.6 `src/lib/domain/releaseLanguage.ts` — `detectLanguages()` heuristic + unit tests (real Prowlarr titles).
- [x] 1.7 `src/lib/domain/availability.ts` — `summarizeAvailability()` (tmdbId filter, per-language rollup) + unit tests.
- [x] 1.8 `src/hooks/useAvailability.ts` + `queryKeys.availability` — search → summarize, 5-min `staleTime`.
- [x] 1.9 `src/features/detail/AvailabilityPanel.tsx` + `detail.css` — found / not-found / loading / muted states, language chips.
- [x] 1.10 Mount `<AvailabilityPanel>` in `DetailScreen` before the "Pedir" action.
- [x] 1.11 Verify: unit tests pass; live E2E through the dev proxy returns results with the key injected and absent from the client.

## Slice 2: TV detail slice

- [x] 2.1 `JellyseerrTvDetailsSchema` + `getTvDetails()` (`GET /api/v1/tv/{id}`).
- [x] 2.2 `requestMedia` — optional `seasons`; TV sends `seasons: 'all'`, movie body unchanged.
- [x] 2.3 `src/hooks/useTitleDetail.ts` — unified movie/tv fetch, normalized `NormalizedDetail`; remove `useMovieDetail`.
- [x] 2.4 `queryKeys.detail(mediaType, id)` — media-type-scoped cache key (id namespaces don't collide).
- [x] 2.5 `useRequestMedia(mediaType)` — parameterize; DetailScreen passes it.
- [x] 2.6 `DetailScreen` — read `?type=`, media-aware primary action (InLibrary series → non-navigating "En biblioteca").
- [x] 2.7 Carry `?type=tv` at nav sites: `PosterCard` (+`mediaType` on `PosterItem`), `SearchScreen`, `HomeScreen` (trending + library via `Type === 'Series'`).
- [x] 2.8 Extend `DetailScreen.test.tsx` — TV fetch, TV request (`mediaType: 'tv'`), InLibrary-series "En biblioteca".
- [x] 2.9 Verify: full suite (150/150) + `tsc -b` clean.

## Verification summary

- **Tests**: 150/150 across 26 files (16 new: 8 language, 6 availability, 2 TV detail).
- **Typecheck**: `tsc -b` exit 0.
- **Live E2E**: browser → `/prowlarr/api/v1/search` (keyless) → proxy injects `X-Api-Key` → Prowlarr → 681 releases; key absent from client.
- **Scope guard**: does not touch the parallel `/radarr`·`/sonarr` download-% / cancel effort.
