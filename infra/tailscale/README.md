# Public exposure via Tailscale Funnel

The `tailscale` service (`poisonflix-ts`) publishes the Caddy proxy to the public
internet over HTTPS on your tailnet domain — no port-forwarding, no owned domain,
no Cloudflare account. It runs in **userspace mode**, so it needs no `NET_ADMIN`
and won't hit the kernel-iptables problems the `jellyfin-ts` sidecar has.

Final public URL: `https://poisonflix.<your-tailnet>.ts.net`

## One-time tailnet setup (admin console — do this once)

1. **HTTPS certificates**: https://login.tailscale.com/admin/dns → enable
   *HTTPS Certificates* (requires MagicDNS on).
2. **Allow Funnel** for this node. In the ACL editor
   (https://login.tailscale.com/admin/acls) add a `nodeAttrs` entry granting
   `funnel`, e.g.:
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
   (Or scope it to a tag and tag this node.)
3. **Auth key**: https://login.tailscale.com/admin/settings/keys → *Generate
   auth key* (Reusable + Ephemeral off; Tag optional). Copy it.

## Wire the key (secret — never committed)

Add the key to the gitignored `infra/.env`:

```
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
```

## Bring it up

```bash
cd infra
docker compose up -d tailscale
docker exec poisonflix-ts tailscale funnel status   # should show :443 -> proxy
docker logs poisonflix-ts | tail -n 20
```

If you prefer interactive login instead of an auth key, leave `TS_AUTHKEY` empty,
then run `docker exec -it poisonflix-ts tailscale up` and open the printed URL.

## Verify

- `https://poisonflix.<tailnet>.ts.net/` → the web app loads.
- `https://poisonflix.<tailnet>.ts.net/radarr/api/v3/movie` in a fresh
  incognito window (no Jellyseerr session) → **401** (BFF blocks anonymous).

## Turn it off

```bash
docker exec poisonflix-ts tailscale funnel reset
docker compose stop tailscale
```
