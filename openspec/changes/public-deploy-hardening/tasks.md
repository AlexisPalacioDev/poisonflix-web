# Tasks — Public Deploy Hardening

## BFF
- [ ] `infra/bff/server.mjs` — zero-dep Node HTTP server: auth via Jellyseerr
      `/auth/me` (cookie), short-TTL cache, `isAdmin` from permissions bit 2.
- [ ] Passthrough policy for `/prowlarr /radarr /sonarr` (GET=auth, grab=auth,
      DELETE/PUT=admin, else 403) with `X-Api-Key` injection + prefix strip.
- [ ] `POST /bff/cancel` — owner-or-admin, server-side cancel orchestration.
- [ ] `infra/bff/Dockerfile` (node:22-alpine, non-root, no network install).

## Infra wiring
- [ ] `infra/docker-compose.yml` — add `poisonflix-bff` service on
      `media-automation`; add `RADARR/SONARR/PROWLARR_API_KEY`, `*_URL`,
      `JELLYSEERR_URL` from `infra/.env`.
- [ ] `infra/.env.example` (committed) + `infra/.env` (gitignored, real keys).
- [ ] `infra/Caddyfile` — route `/prowlarr /radarr /sonarr` + `/bff/*` to
      `poisonflix-bff:8787`; restore radarr/sonarr; drop Caddy key injection.
- [ ] `infra/tailscale/` — `poisonflix-ts` Funnel sidecar (userspace) → proxy
      `:8600`; document the interactive `tailscale up` / funnel enable step.

## Frontend
- [ ] `src/lib/http/client.ts` — `credentials:'include'` for radarr/sonarr; comment.
- [ ] `src/lib/session/store.ts` — `isAdmin` field.
- [ ] `src/lib/domain/onboardingAuth.ts` — capture `isAdmin` from permissions.
- [ ] `src/hooks/useCancelDownload.ts` — call `POST /bff/cancel`.
- [ ] Hide library-delete action from non-admins (DetailScreen + +18).
- [ ] Tests: `client.test.ts`, `arr.test.ts`, `useCancelDownload` — update to the
      new contract; add BFF-cancel + admin-gate assertions.

## Deploy (checkpoint-gated)
- [ ] `npm test` + `npm run build` green; rebuild `infra/www`.
- [ ] **CHECKPOINT** → bring up BFF, reload proxy on the host.
- [ ] Run the verification matrix against the live stack.
- [ ] **CHECKPOINT** → enable Tailscale Funnel; end-to-end check from public URL.
