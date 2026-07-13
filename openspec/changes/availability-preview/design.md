# Design: availability-preview

Status: implemented
Change: `availability-preview`
Reads: proposal.md

## 1. Overview

Two cooperating additions to the existing detail screen:

1. **Availability preview** — a self-contained panel that runs a Prowlarr search for the current title and renders a language/seeder summary.
2. **Media-agnostic detail** — the detail fetch/action layer now handles movies *and* TV, which is what lets series host the panel at all.

Both preserve the MVP's layering: same-origin `apiFetch` backend, TanStack Query hooks, pure domain functions, presentational components.

## 2. Layer map (new/changed files)

| Layer | File | Role |
|-------|------|------|
| Proxy | `vite.config.ts`, `infra/Caddyfile`, `infra/docker-compose.yml` | `/prowlarr/*` same-origin route; `X-Api-Key` injected server-side |
| API client | `src/lib/http/client.ts` | `prowlarr` added to `Backend` + `BASE_URLS`; no browser credential attached |
| API client | `src/api/prowlarr.ts` + `src/api/schemas/prowlarr.ts` | `searchReleases(query)` + defensive Zod schema |
| API client | `src/api/jellyseerr.ts` + `src/api/schemas/jellyseerr.ts` | `getTvDetails()`; `JellyseerrTvDetailsSchema`; `requestMedia` gains optional `seasons` |
| Domain (pure) | `src/lib/domain/releaseLanguage.ts` | `detectLanguages(title)` heuristic |
| Domain (pure) | `src/lib/domain/availability.ts` | `summarizeAvailability(releases, {tmdbId})` aggregator |
| Hooks | `src/hooks/useAvailability.ts` | react-query: search → summarize, 5-min `staleTime` |
| Hooks | `src/hooks/useTitleDetail.ts` | unified movie/tv detail (replaces `useMovieDetail`) |
| Hooks | `src/hooks/useRequestMedia.ts` | now takes `mediaType` |
| Hooks | `src/hooks/queryKeys.ts` | `availability`, `detail(mediaType, id)` keys |
| UI | `src/features/detail/AvailabilityPanel.tsx` + `detail.css` | the panel |
| UI | `src/features/detail/DetailScreen.tsx` | reads `?type=`, uses `useTitleDetail`, media-aware action |
| Nav | `src/components/PosterCard.tsx`, `src/features/search/SearchScreen.tsx`, `src/features/home/HomeScreen.tsx` | carry `?type=tv` |

## 3. Data flow

```
DetailScreen(?type)
  ├─ useTitleDetail(id, mediaType) ── getMovieDetails | getTvDetails ─→ NormalizedDetail
  └─ AvailabilityPanel(title, tmdbId)
        └─ useAvailability(title, tmdbId)
              ├─ searchReleases(title)  ──/prowlarr/api/v1/search──▶ [proxy injects X-Api-Key] ──▶ Prowlarr
              └─ summarizeAvailability(releases, {tmdbId})
                    └─ detectLanguages(title)   (per release)
```

## 4. ADRs

### ADR-1 — Panel is a sibling query, never on the detail critical path
The panel owns its own `useQuery`; the detail render does not `await` it. A slow/failed indexer search degrades to a muted "no se pudo consultar" line and never blanks the title/overview/action. (Confirmed by the full suite passing with the panel mounted and `fetch` unmocked — it fails soft in jsdom.)

### ADR-2 — Server-side key injection, browser sends no credential
`/prowlarr` (and, by the parallel effort, `/radarr`·`/sonarr`) inject `X-Api-Key` at the proxy. `client.ts` deliberately attaches **neither** `X-Emby-Token` **nor** `credentials:'include'` for these backends, so the key exists only server-side. Prod requires `PROWLARR_API_KEY` in the Caddy service env (`docker-compose.yml`).

### ADR-3 — `tmdbId` filter keeps id-less releases
`summarizeAvailability` drops a release only when it reports a *different* `tmdbId`; releases with a matching id — or `0`/absent, the common public-tracker case — are kept. This removes clearly-wrong titles without discarding the majority that carry no id.

### ADR-4 — Normalize TV onto the movie-shaped detail
`useTitleDetail` maps `name→title`, `firstAirDate→releaseDate`, `episodeRunTime[0]→runtime`, so `DetailScreen` JSX and the `LibraryIndex` status join are identical for both media types. The only media-aware branch is the InLibrary action (TV → non-navigating "En biblioteca", since direct series playback is deferred).

## 5. Testing

- Pure functions unit-tested against **real Prowlarr titles** (`releaseLanguage.test.ts`, `availability.test.ts`).
- `DetailScreen.test.tsx` extended with TV coverage (fetches `/tv/{id}`, requests as `tv`, InLibrary series shows "En biblioteca").
- End-to-end proxy path verified live: `GET /prowlarr/api/v1/search` through the dev proxy returned 681 releases with the key injected and absent from the client.
