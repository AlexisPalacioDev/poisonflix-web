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
docker compose up -d --build bff caddy

echo "==> smoke test (expect: / -> 200, /radarr -> 401)"
ok=1
for i in $(seq 1 10); do
  home=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/ || echo 000)
  [[ "$home" == "200" ]] && break
  sleep 1
done
arr=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/radarr/api/v3/queue || echo 000)
echo "  /                    -> $home"
echo "  /radarr/api/v3/queue -> $arr"
[[ "$home" == "200" && "$arr" == "401" ]] || { echo "SMOKE TEST FAILED — consider ./infra/deploy.sh --rollback" >&2; ok=0; }

[[ "$ok" == "1" ]] && echo "==> deploy OK" || exit 1
