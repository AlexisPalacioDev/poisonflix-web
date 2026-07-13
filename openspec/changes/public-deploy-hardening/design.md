# Design — Public Deploy Hardening

## Threat model

Public origin over Tailscale Funnel. Adversaries:
1. **Anonymous internet** — no Jellyseerr session. Must reach *nothing* under
   `/prowlarr /radarr /sonarr`.
2. **Authenticated non-admin** (a logged-in family member) — may read state and
   cancel **their own** downloads, but must not delete library items or drive
   another user's downloads.
3. **Client tampering** — a logged-in user crafting raw requests in devtools.
   Authorization therefore lives on the **server (BFF)**, never in the SPA. UI
   hiding is UX only, not a security boundary.

Keys must never reach the browser (unchanged invariant).

## Why a BFF (not Caddy `forward_auth` alone)

Caddy can gate on "logged in" and, with an admin-only upstream endpoint, on
"is admin". It **cannot** express "is this download **yours**?" — Radarr/Sonarr
have no concept of a user; ownership lives in Jellyseerr (`request.requestedBy`).
Enforcing owner-or-admin cancel requires code that: resolves the Jellyseerr
request owner, compares it to the caller, and only then performs the `*arr`
queue delete with the admin key. That code is the BFF. The BFF also becomes the
single key-holder, shrinking the trusted surface to one service.

## Topology

```
Internet ──(Tailscale Funnel, HTTPS)──> poisonflix-ts ──> poisonflix-proxy (Caddy :8600)
                                                              ├─ /jellyfin/*   → jellyfin-ts:8096   (unchanged)
                                                              ├─ /jellyseerr/* → jellyseerr:5055     (unchanged)
                                                              ├─ /updates/*    → static APK          (unchanged, public)
                                                              ├─ /prowlarr/*  ┐
                                                              ├─ /radarr/*    ├─→ poisonflix-bff:8787 → *arr (+X-Api-Key)
                                                              ├─ /sonarr/*    ┘
                                                              ├─ /bff/*        → poisonflix-bff:8787
                                                              └─ /*            → SPA (unchanged)
```

Caddy no longer injects any `X-Api-Key`; it just reverse-proxies to the BFF and
forwards the `Cookie` header. The BFF joins `media-automation` to reach
`radarr:7878`, `sonarr:8989`, `prowlarr:9696`, `jellyseerr:5055` by name.

## BFF contract

Env (from gitignored `infra/.env`): `RADARR_API_KEY`, `SONARR_API_KEY`,
`PROWLARR_API_KEY`, `JELLYSEERR_URL=http://jellyseerr:5055`,
`RADARR_URL`, `SONARR_URL`, `PROWLARR_URL`, `PORT=8787`.

### Auth (every request)
1. Read the `Cookie` header. `GET {JELLYSEERR_URL}/api/v1/auth/me` forwarding it.
2. Non-2xx → `401`. 2xx → parse `{ id, permissions }`.
   `isAdmin = (permissions & 2) === 2` (Jellyseerr `Permission.ADMIN = 2`).
   Cache the result keyed by cookie for a short TTL (~30 s) to avoid hammering
   Jellyseerr on burst polls.

### Passthrough routes `/{prowlarr|radarr|sonarr}/*`
| Method + path | Policy |
| --- | --- |
| `GET` (queue, movie, series, episode, search) | any authenticated user |
| `POST /prowlarr/api/v1/search` (grab / "Pedir") | any authenticated user |
| `DELETE` / `PUT` on radarr/sonarr | **admin only** → else `403` |
| anything else | `403` |

Authorized requests are forwarded to the mapped `*arr` with the strip-prefix
rewrite and the injected `X-Api-Key`; the response is streamed back verbatim.

### Orchestrated route `POST /bff/cancel`
Body `{ requestId: number, tmdbId: number | null }`. Policy: caller is the
request **owner** (`GET /api/v1/request/{id}` → `requestedBy.id === caller.id`)
**or** admin; else `403`. On pass, the BFF runs the former client-side cancel
chain server-side with the admin key: resolve movie/series by tmdbId, delete
matching queue items (`removeFromClient=true, blocklist=false`), unmonitor, then
`DELETE /api/v1/request/{id}` on Jellyseerr **with the caller's cookie** (so
Jellyseerr's own owner/admin check is the final backstop). Radarr/Sonarr steps
are best-effort (mirrors current behavior); the Jellyseerr delete is the only
step allowed to fail the request.

## Frontend changes

- `client.ts`: add `radarr`/`sonarr` to the `credentials:'include'` branch
  (Prowlarr already sends the cookie) so the BFF receives `connect.sid`. Update
  the 401 handling comment — a 401 from `*arr` now means "not authenticated",
  still swallowed for background polls.
- `session/store.ts`: add `isAdmin: boolean`. `onboardingAuth.ts` computes it
  from the `authJellyfin` response `permissions` and persists it.
- `useCancelDownload.ts`: replace the multi-call `*arr` orchestration with a
  single `POST /bff/cancel`. Ownership/admin is enforced by the BFF.
- UI: hide the **library delete** action from non-admins (DetailScreen and any
  +18 delete). Cancel stays visible to all — the BFF authorizes owner-or-admin.
- Dev (`vite.config.ts`): dev proxy stays keyless/authless against localhost
  `*arr`; optionally point dev at a locally-run BFF later. Not required for prod.

## Rollout & safety

- All file changes are inert until containers are rebuilt. **Checkpoint** before
  `docker compose up`/proxy reload, and again before enabling Funnel.
- Verification matrix (against the live stack): anonymous → 401; logged-in
  non-admin → reads OK, `DELETE /radarr/...` → 403, cancel own → OK, cancel
  other's → 403; admin → all OK; keys never present in any browser response.
- Rollback: revert the Caddyfile `*arr` blocks to direct `reverse_proxy` and
  stop the BFF; the previous behavior returns.

## Alternatives considered

- **Caddy `forward_auth` only (no BFF):** rejected — cannot do owner-scoped
  cancel; would silently drop non-admin cancels (request removed in Jellyseerr
  but download keeps running). Accepted earlier as a "minimal" step, superseded
  by the full-BFF go-ahead.
- **Cloudflare Tunnel:** viable but needs a domain + CF account; Tailscale Funnel
  reuses the existing tailnet with zero extra accounts.
