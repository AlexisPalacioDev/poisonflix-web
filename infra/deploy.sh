#!/usr/bin/env bash
# One-command deploy for the home host.
#
# Builds the web app, swaps the bundle Caddy serves, (re)builds the BFF, reloads
# the proxy, and smoke-tests the security boundary. A backup of the previous
# bundle is kept at infra/www.bak for a fast rollback.
#
#   ./infra/deploy.sh            # deploy (builds Vite + Docker images on this host)
#   ./infra/deploy.sh --no-build # skip `npm ci && npm run build` and reuse the
#                                 # dist/ already checked out on this host. For
#                                 # when the Vite build itself is the load that
#                                 # matters — this box is a desktop board that has
#                                 # blacked out under build load before (see
#                                 # infra/deploy-from-laptop.sh, which builds on a
#                                 # laptop, rsyncs dist/ here, then runs this with
#                                 # --no-build). Docker builds for bff/music-worker
#                                 # still happen here either way.
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

no_build=0
[[ "${1:-}" == "--no-build" ]] && no_build=1

if [[ "$no_build" == "1" ]]; then
  echo "==> --no-build: skipping npm ci/build, reusing dist/ already on this host"
  # A missing or empty dist/ here means either nobody ever built on this host,
  # or a laptop rsync (infra/deploy-from-laptop.sh) failed partway through.
  # Silently proceeding would swap infra/www for a phantom/partial bundle —
  # the local+public smoke tests below would then be testing garbage. Fail
  # loudly instead, before anything is touched.
  if [[ ! -d dist ]] || [[ -z "$(ls -A dist 2>/dev/null)" ]]; then
    echo "dist/ is missing or empty — refusing to deploy with --no-build." >&2
    echo "Populate it first: ./infra/deploy-from-laptop.sh (from your laptop), or drop --no-build to build here." >&2
    exit 1
  fi
else
  echo "==> installing deps + building web"
  npm ci
  npm run build
fi

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
# Hard timeout on every `docker exec` in this section. `tailscale status`/
# `funnel status` talk to tailscaled inside the sidecar, and this script just
# restarted that exact container a few lines above (`docker compose restart
# tailscale`). If tailscaled hasn't finished coming back up yet, the CLI
# blocks waiting on its control socket instead of erroring — with no timeout
# this hung the WHOLE script for 8+ minutes past a deploy that had already
# finished successfully, twice, and had to be killed by hand. 8s is generous
# for a warm daemon answering a local query; a sidecar still stuck after that
# falls through to "UNVERIFIED" below instead of eating the rest of the run.
docker_exec_timeout=8

# `|| true` on both assignments below matters under `set -eo pipefail`: when
# `timeout` actually fires, the pipeline's exit status is timeout's 124 (not
# node's 0), and pipefail propagates that as the pipeline's own nonzero
# status. Without `|| true`, errexit would kill the WHOLE deploy script right
# here on a slow-booting sidecar — turning "public path unverified" (which we
# can report and continue past) into an uncontrolled abort of a deploy that
# already succeeded locally. `|| true` lets a timeout fall through to the
# same empty-fqdn handling as any other lookup failure.
fqdn=$(timeout "$docker_exec_timeout" docker exec poisonflix-ts tailscale status --json 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).Self?.DNSName||"").replace(/\.$/,""))}catch{}})') || true
# The JSON path above is fragile — a schema change, a truncated read, or a
# sidecar that's still booting (timeout above) leaves fqdn empty, and this
# check used to just skip while the script still printed "deploy OK (local +
# public)". That is the exact lie the public smoke test exists to prevent,
# so fall back to the human-readable funnel status.
if [[ -z "$fqdn" ]]; then
  fqdn=$(timeout "$docker_exec_timeout" docker exec poisonflix-ts tailscale funnel status 2>/dev/null \
    | grep -oE 'https://[a-zA-Z0-9._-]+\.ts\.net' | head -1 | sed 's#https://##') || true
  [[ -n "$fqdn" ]] && echo "  (hostname from JSON failed; using funnel status: $fqdn)"
fi
pub=000
if [[ -n "$fqdn" ]]; then
  # Bounded by TOTAL elapsed wall-clock time, not a fixed retry count. The
  # old `seq 1 12` loop was bounded too, but only in theory: 12 * (8s DNS +
  # 10s curl + 3s sleep) is up to ~4 minutes, which is long enough to read as
  # the same hang this section exists to fix. A time budget caps the worst
  # case at ~75s no matter how many attempts fit inside it, and still retries
  # as long as budget remains instead of stopping after an arbitrary count.
  funnel_budget_secs=75
  deadline=$((SECONDS + funnel_budget_secs))
  while [[ $SECONDS -lt $deadline ]]; do
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
  echo "  UNVERIFIED: could not read the funnel hostname (sidecar may still be restarting), so the public path was never checked." >&2
  echo "  The deploy may be live locally and dead for everyone else. Check by hand:" >&2
  echo "    docker exec poisonflix-ts tailscale funnel status" >&2
  pub=skipped
fi

if [[ "$ok" != "1" ]]; then
  exit 1
elif [[ "$pub" == "skipped" ]]; then
  # Never claim the public path is up when nothing proved it.
  echo "==> deploy OK locally — PUBLIC PATH UNVERIFIED (see above)"
else
  echo "==> deploy OK (local + public)"
fi
