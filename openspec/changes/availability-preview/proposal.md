# Proposal: availability-preview

Status: implemented (retroactive — code landed and verified before this artifact was written)
Change: `availability-preview`
Reads: — (follow-up to the `poisonflix-web` MVP change)
Feeds: `sdd-spec`, `sdd-design`
Reference app: `/home/alexis/Documentos/poisonflix` (Kotlin Compose-for-TV)

## 1. Intent

Give the user a **pre-download availability signal** on the detail screen: before committing to "Pedir", show whether the title actually exists on the torrent indexers and **in which languages** (English, Spanish/Latino, …). The problem this solves is concrete and was observed live — content requested days ago (e.g. *Mr. Robot* Season 1) sat incomplete with no feedback, because the *arr download layer was silently failing and the client had no window into it. A title that simply **isn't out there**, or is **English-only** when the user wants Spanish, should be visible up front instead of stalling invisibly in the download queue for days.

A second, enabling piece is folded into this change: the detail screen was **movies-only**, so series (the exact case that motivated this) never reached a detail screen that could host the panel. This change makes the detail screen **media-type-aware** so the availability preview works for TV as well as movies.

Success means: opening any movie **or series** detail shows a panel stating "No encontrado en torrents" or "Disponible en torrents" with a per-language seeder breakdown, sourced from a real cross-indexer search, with the indexer API key never reaching the browser.

## 2. Scope

### In scope
- **Availability preview capability** — a detail-screen panel showing torrent presence, release count, best seeder health, and a per-language breakdown, backed by a **Prowlarr** manual search.
- **Same-origin Prowlarr proxy** — `/prowlarr/*` route (Vite dev + Caddy prod) that injects `X-Api-Key` **server-side**, matching the existing `/jellyfin`·`/jellyseerr` same-origin pattern.
- **Language inference** — a pure, tested heuristic that derives release languages from titles (Prowlarr does not populate a structured `languages` field).
- **TV detail slice** — the detail screen fetches `/tv/{id}` for series, normalizing TMDB's TV field names onto the shared detail shape; `?type=tv` disambiguates the TMDB id; TV requests go out as the whole series (`seasons: 'all'`).

### Out of scope
- **Backend changes** — Prowlarr / Sonarr / Radarr / Jellyseerr consumed as-is.
- **Interactive grab / release selection** — the panel is read-only; it does not let the user pick a specific release to download (that is a Sonarr/Radarr interactive-search concern, and requires the item already tracked).
- **Live download-% / cancel / delete** — a separate, parallel effort over the `/radarr`·`/sonarr` proxies; not part of this change.
- **TV two-pane season/episode detail + TV playback** — still deferred per the `poisonflix-web` MVP; an InLibrary series shows "En biblioteca", not a broken "Reproducir".

### Deferred (seams kept open)
- Enriching language accuracy by cross-referencing Sonarr/Radarr's structured `languages[]` when a title is already tracked (hybrid Prowlarr + *arr).
- Per-season availability for TV.

## 3. Approach

The panel is an **isolated, non-blocking** addition to the existing detail screen — its own query, its own loading/error state — so a slow indexer search never blocks the poster/overview/"Pedir" render (mirrors the MVP's row-isolation discipline).

- **Data source = Prowlarr, not Sonarr/Radarr.** The user's requirement is explicitly *before* requesting. Sonarr/Radarr interactive search (`/api/v3/release`) needs the title already added (a `movieId`/`seriesId`); Prowlarr's `/api/v1/search` searches every configured indexer for an arbitrary query with no such precondition. That precondition difference is the whole reason for the choice (see Decision 1).
- **Same-origin proxy with server-side key injection** ← the established `apiFetch` backend pattern. A new `prowlarr` backend maps to `/prowlarr`; the proxy (Vite `configure` / Caddy `header_up`) attaches `X-Api-Key` so no credential ships in the client bundle.
- **Language from titles** ← a pure `detectLanguages()` heuristic (`src/lib/domain/releaseLanguage.ts`) + a pure `summarizeAvailability()` aggregator (`src/lib/domain/availability.ts`), both directly unit-tested — the same "pure domain functions" layer the MVP uses.
- **Media-agnostic detail** ← `useTitleDetail(tmdbId, mediaType)` replaces the movie-only `useMovieDetail`, normalizing `/movie/{id}` and `/tv/{id}` onto one `NormalizedDetail` shape so the screen JSX is unchanged. `mediaType` travels via a `?type=tv` query param set at every navigation site (PosterCard, Search, Home).

## 4. Decisions

### Decision 1 — Availability source: Prowlarr manual search, not Sonarr/Radarr interactive search. **GO.**
**Verdict:** Back the panel with Prowlarr `GET /api/v1/search?query=&type=search`.
**Rationale:** The requirement is a *pre-request* preview. Sonarr/Radarr's `/release` interactive search only works for a title already added to that *arr instance (it is keyed by internal `movieId`/`seriesId`), so it cannot answer "what's out there?" for something the user hasn't requested yet. Prowlarr searches all indexers for a free-text query with no such precondition, and its results even carry `tmdbId`/`imdbId` for match filtering.
**Tradeoffs:** Prowlarr returns an **empty** `languages` field, so language must be inferred from release titles (Decision 2). Accepted: pre-request coverage is the hard requirement; language precision is a best-effort heuristic.
**Rejected alternative:** Sonarr/Radarr `/release` — cleaner structured `languages[]`/`quality`, but the "must already be added" precondition defeats the pre-request goal.

### Decision 2 — Language via title heuristic, English as the unmarked default. **GO.**
**Verdict:** Infer languages from the release title with a word-boundary marker set; a release with no foreign-language marker is reported as English.
**Rationale:** Prowlarr gives no structured language. Foreign audio is almost always tagged explicitly ("Latino", "Castellano", "VOSTFR", …), so "no marker → English" matches the *arr parser convention and avoids a useless "unknown" bucket that would hide English availability.
**Tradeoffs:** Imperfect on oddly-tagged releases (mitigated: conservative markers, short/ambiguous tokens excluded; unit-tested against real Prowlarr titles).
**Rejected alternative:** Reporting untagged releases as "unknown" — technically honest but makes the common English case disappear from the breakdown, defeating the "is it in English?" question.

### Decision 3 — Media-type carried via `?type=tv` query param. **GO.**
**Verdict:** Disambiguate the ambiguous `/detail/:id` TMDB id with a `?type=tv` search param (absent → movie).
**Rationale:** TMDB reuses numeric ids across the movie and tv namespaces, so `/movie/{id}` for a series could silently return a **different** movie. The route param alone cannot disambiguate; a query param does, without adding a new route or breaking existing movie links (which stay param-less → movie).
**Tradeoffs:** Every navigation site must tag TV (PosterCard, Search, Home). Accepted: small, mechanical, and back-compatible.
**Rejected alternative:** Try `/movie/{id}` then fall back to `/tv/{id}` on 404 — unsafe, because a shared numeric id returns a wrong-namespace title with a 200, not a 404.
