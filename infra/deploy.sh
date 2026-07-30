#!/usr/bin/env bash
# One-command deploy for the home host.
#
# Builds the web app, swaps the bundle Caddy serves, (re)builds the BFF, reloads
# the proxy, and smoke-tests the security boundary. A backup of the previous
# bundle is kept at infra/www.bak for a fast rollback.
#
#   ./infra/deploy.sh            # deploy
#   ./infra/deploy.sh --rollback # restore the previous bundle + reload proxy
#
# Requires infra/.env (see infra/env.example). Public exposure (Tailscale Funnel)
# is separate — see infra/tailscale/README.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [[ "${1:-}" == "--rollback" ]]; then
  echo "==> rollback: restoring infra/www.bak"
  [[ -d infra/www.bak ]] || { echo "no infra/www.bak to restore" >&2; exit 1; }
  rm -rf infra/www && mv infra/www.bak infra/www
  (cd infra && docker compose up -d --force-recreate caddy)
  echo "rollback done."
  exit 0
fi

echo "==> installing deps + building web"
npm ci
npm run build

echo "==> swapping infra/www (keeping infra/www.bak)"
rm -rf infra/www.bak
[[ -d infra/www ]] && mv infra/www infra/www.bak
cp -r dist infra/www

echo "==> (re)building BFF + reloading proxy"
cd infra
# Caddy MUST be force-recreated: `mv infra/www infra/www.bak && cp -r dist
# infra/www` above replaces the bind-mounted directory with a NEW inode, but a
# still-running container keeps serving the OLD inode (now www.bak). Without
# --force-recreate, `docker compose up` leaves Caddy untouched (config/image
# unchanged) and it silently serves the previous bundle.
# music-worker MUST be here too. Both server.mjs and server.py are baked into
# their images (neither is bind-mounted), and this line used to build only `bff` —
# so editing infra/music-worker/server.py and running this script was a COMPLETE
# SILENT NO-OP: it printed "deploy OK" and both smoke tests passed, because they
# only probe / and /radarr. The BFF would go on allowlisting a route the running,
# stale worker still answered 404 for, which is the real mechanism behind "the
# endpoint exists but the front-end gets a 404".
docker compose up -d --build bff music-worker
docker compose up -d --force-recreate caddy

# Force-recreating Caddy gives it a NEW container. The Tailscale Funnel sidecar
# keeps routing to the old one, so the PUBLIC ingress silently goes dead while
# `tailscale funnel status` still reports "on" and localhost:8600 still serves
# fine. This is the recurring "site is down for the family but works locally"
# failure. Restarting the sidecar forces it to re-resolve poisonflix-proxy and
# the public path comes back (~15s later). It's cheap, so always do it.
echo "==> healing Tailscale Funnel (restart sidecar after caddy recreate)"
docker compose restart tailscale

echo "==> smoke test (expect: / -> 200, /radarr -> 401)"
ok=1
for i in $(seq 1 10); do
  home=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/ || echo 000)
  [[ "$home" == "200" ]] && break
  sleep 1
done
# Retry the boundary check too: a freshly-recreated BFF may still be booting,
# in which case the proxy returns a transient 502 instead of the BFF's 401.
for i in $(seq 1 10); do
  arr=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/radarr/api/v3/queue || echo 000)
  [[ "$arr" == "401" ]] && break
  sleep 1
done
echo "  /                    -> $home"
echo "  /radarr/api/v3/queue -> $arr"
[[ "$home" == "200" && "$arr" == "401" ]] || { echo "SMOKE TEST FAILED — consider ./infra/deploy.sh --rollback" >&2; ok=0; }

# PUBLIC Funnel smoke test. The checks above only prove the LOCAL proxy serves;
# they pass even when the public ingress is dead. Verify the real external path
# so a broken Funnel FAILS the deploy loudly instead of reporting "deploy OK".
# This box's own resolver can't resolve *.ts.net, so resolve the funnel host via
# public DNS-over-HTTPS and hit Tailscale's ingress with curl --resolve.
echo "==> public Funnel smoke test"
fqdn=$(docker exec poisonflix-ts tailscale status --json 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).Self?.DNSName||"").replace(/\.$/,""))}catch{}})')
pub=000
if [[ -n "$fqdn" ]]; then
  for i in $(seq 1 12); do
    ip=$(curl -s --max-time 8 "https://dns.google/resolve?name=${fqdn}&type=A" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=(JSON.parse(d).Answer||[]).find(x=>x.type===1);process.stdout.write(a?a.data:"")}catch{}})')
    [[ -n "$ip" ]] && pub=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "${fqdn}:443:${ip}" "https://${fqdn}/" || echo 000)
    [[ "$pub" == "200" ]] && break
    sleep 3
  done
  echo "  https://$fqdn/ -> $pub"
  [[ "$pub" == "200" ]] || { echo "PUBLIC FUNNEL DOWN after deploy — up locally but NOT reachable by the family. Try: docker compose restart tailscale" >&2; ok=0; }
else
  echo "  (skipped: could not read funnel hostname from tailscale status)"
fi

[[ "$ok" == "1" ]] && echo "==> deploy OK (local + public)" || exit 1
