# poisonflix-web

A thin, same-origin React + Vite PWA client over the existing Jellyfin +
Jellyseerr (+ \*arr) media stack — browser first, webOS `.ipk` and mobile
PWA install deferred. See `openspec/changes/poisonflix-web/` for the full
SDD plan (proposal, design, specs, tasks).

## Prerequisite: reverse proxy (BLOCKING)

This app makes only **relative** requests to `/jellyfin/*` and
`/jellyseerr/*` — there are no hostnames in the client. That only works
if something puts the app and both backends behind a single origin.

In production that's the Caddy reverse proxy in [`infra/`](./infra):

- `infra/Caddyfile` strips the `/jellyfin` and `/jellyseerr` prefixes and
  reverse-proxies to the Jellyfin and Jellyseerr containers, and serves
  the built app (`dist/`) for everything else.
- `infra/docker-compose.yml` runs it (`docker compose -f infra/docker-compose.yml up -d`).

**Onboarding cannot succeed without this.** A CORS/connectivity failure
(proxy not up) is surfaced as a distinct error message from an invalid-
credentials (401) failure — see design.md §3.1/§6.

## Same-origin path contract

| Path prefix     | Strips to | Backend               |
| ---------------- | --------- | ---------------------- |
| `/jellyfin/*`    | `/*`      | Jellyfin (`:8096`)      |
| `/jellyseerr/*`  | `/*`      | Jellyseerr (`:5055`)    |

This contract is mirrored in **two** places and must stay in lockstep:

- `infra/Caddyfile` (`handle_path` blocks) — production.
- `vite.config.ts` (`server.proxy` with a `rewrite` stripping the prefix) — local dev.

## Dev vs prod

- **Dev**: `npm run dev` starts Vite's dev server on `http://localhost:5173`,
  proxying `/jellyfin` → `http://localhost:8096` and `/jellyseerr` →
  `http://localhost:5055` (adjust the proxy targets in `vite.config.ts` if
  your backends run elsewhere). No reverse proxy needed for local dev —
  Vite's proxy plays that role.
- **Prod**: `npm run build` emits static assets to `dist/`, which the Caddy
  proxy in `infra/` serves from `/srv` alongside the two backend prefixes.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-checks (tsc -b) + builds to dist/
npm test         # vitest run
```

## Project structure

See `openspec/changes/poisonflix-web/design.md` §2 for the full annotated
tree and the Kotlin-reference-app → web-layer mapping this codebase follows.
