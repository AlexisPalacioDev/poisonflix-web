# Public Deploy Hardening

## Why

poisonflix-web currently runs on a same-origin Caddy proxy (`:8600`) that serves
the SPA and forwards to Jellyfin, Jellyseerr, Prowlarr, Radarr and Sonarr. Today
the `*arr` routes are **unauthenticated**: Caddy injects each backend's admin
`X-Api-Key` server-side, so *any* client that reaches `:8600/radarr/...` drives
Radarr/Sonarr/Prowlarr with full admin rights — including
`DELETE /radarr/api/v3/movie/{id}?deleteFiles=true`, which erases the media file.

On a private LAN this is an accepted risk (ADR-5). We now want a **public
deployment** (family + friends, ~20–100 users) exposed over the internet via
**Tailscale Funnel**. Exposing the current setup would hand admin control of the
media stack to anyone on the internet. This change closes that hole.

## What changes

- Introduce a small **BFF** (`infra/bff/`, zero-dependency Node) that becomes the
  **only** component holding the `*arr` API keys and the **only** upstream Caddy
  routes `/prowlarr /radarr /sonarr` to.
- The BFF authenticates every `*arr` request against the caller's Jellyseerr
  session (`/api/v1/auth/me` with the same-origin `connect.sid` cookie) and
  applies an authorization policy:
  - **Reads** (`GET`) and **Prowlarr grab** (`POST /search`): any authenticated user.
  - **Cancel a download**: the download's **owner** or an **admin**
    (`POST /bff/cancel`, orchestrated server-side).
  - **Destructive `*arr` writes** (`DELETE`/`PUT` — e.g. library delete): **admin only**.
- Repair the production `Caddyfile`, which lost its `/radarr` and `/sonarr`
  handlers in a prior reconstruction (only `/prowlarr` survived).
- Frontend: send the Jellyseerr cookie on `radarr`/`sonarr` calls, capture the
  caller's admin flag at login, route cancel through the BFF, and hide
  admin-only actions from non-admins.
- Expose the proxy publicly with a dedicated **Tailscale Funnel** sidecar.

## Scope

- **In scope:** `poisonflix-web` repo only — `infra/` (BFF, Caddy, compose,
  Tailscale) and `src/` (frontend). Backends are third-party containers touched
  via env only.
- **Out of scope:** the native Kotlin `poisonflix` app — it talks to the LAN
  backends directly (`192.168.1.61:8096/5055`), never through this proxy, so it
  is unaffected. Encryption-at-rest of the localStorage session (ADR-5) is
  unchanged.

## Non-goals

- No user-management UI: admin approval of who may log in stays in
  Jellyfin/Jellyseerr, which already own accounts.
- No rate limiting / WAF in this pass (Funnel + auth is the boundary; revisit later).
