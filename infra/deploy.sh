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

# MUST come after the infra/www swap above, and before Caddy is recreated. The
# EmulatorJS runtime lives INSIDE infra/www, so `mv infra/www infra/www.bak`
# just carried it off with the previous bundle — without this line every deploy
# would leave /emulatorjs/* 404 and "modo gamer" dead, while both smoke tests
# below (they only probe / and /radarr) still printed "deploy OK". The script
# keeps its own cache outside infra/www, so this is a hardlink copy on every
# run after the first, not a 289 MB download.
#
# Non-fatal on purpose: a failed third-party download must not abort a deploy
# of the whole site. It is reported loudly in the summary instead, because a
# silent "games just don't work" is exactly the failure mode this file keeps
# collecting comments about.
emulatorjs_ok=1
./fetch-emulatorjs.sh || emulatorjs_ok=0

# Create the ROM library deliberately, and SAY SO, rather than letting Docker's
# create_host_path conjure it on first mount. Both end with the same empty
# directory; the difference is that this one leaves a line saying where it is,
# so "the shelf is empty" and "the mount points somewhere nobody has put ROMs"
# stop looking identical. The BFF logs the same distinction at runtime.
#
# The host path comes from `docker compose config`, not from reading .env here.
# This script never sources that file — compose does — so `$DATA_DIR` is unset
# in this shell on a perfectly healthy host, and scraping it with awk got both
# halves wrong:
#
#   no .env at all  -> awk exits non-zero, and under `set -o pipefail` the whole
#                      deploy died on this line with NO output whatsoever. The
#                      exact state of a host where nobody has copied env.example
#                      yet, i.e. the first deploy.
#   inline comment  -> `DATA_DIR=/data # the big disk` parsed as the literal
#                      `/data # the big disk`, and the mkdir below would then
#                      cheerfully create a directory with the comment in its name.
#
# `docker compose config` is the only thing that reads that file with the real
# rules, and it resolves the mount for us, so the path below is the one Docker
# will actually bind rather than our guess at it. `|| true` for the same reason
# as everywhere else in this script: an optional feature must not abort a deploy.
games_mount="$(docker compose config --format json 2>/dev/null \
  | python3 -c 'import json,sys
try:
    cfg = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for volume in cfg.get("services", {}).get("bff", {}).get("volumes", []) or []:
    if volume.get("target") == "/games":
        print(volume.get("source", ""))
        break' 2>/dev/null || true)"

if [[ -n "$games_mount" && ! -d "$games_mount" ]]; then
  mkdir -p "$games_mount"
  echo "==> created the ROM library at $games_mount (empty — one folder per system inside)"
elif [[ -z "$games_mount" ]]; then
  echo "==> could not resolve the ROM library mount from docker compose config; skipping (games will report an unreadable library at runtime)"
fi

# Same reasoning as the ROM library above, but with teeth. The webOS pairing
# store is a RELATIVE bind (`./cast-bridge/data` in docker-compose.yml) and is
# not in git, so nothing creates it until someone deploys. Left to Docker's
# create_host_path it lands root:root on first `up`, the container runs as
# `USER node` (uid 1000 in node:22-alpine), and storeKey() then fails with
# EACCES on EVERY pairing. The visible symptom is not an error: it is the LG
# putting its permission dialog on screen at every single cast, forever, which
# reads as normal television behaviour. Creating it here means it belongs to
# whoever deploys instead of to root.
#
# Not derived from DATA_DIR on purpose: this path is relative to the compose
# file, and the working directory is already infra/ by this point.
if [[ ! -d cast-bridge/data ]]; then
  mkdir -p cast-bridge/data
  echo "==> created the cast pairing store at infra/cast-bridge/data (webOS client-keys)"
fi
# Owning it is not enough — it has to be owned by the uid INSIDE the container.
# A host that deploys as some other uid reproduces the same EACCES wearing a
# different hat, so check instead of assuming. Best-effort and never fatal:
# chown needs privileges this script may not have, and casting is optional.
chmod 700 cast-bridge/data 2>/dev/null || true
cast_dir_uid="$(stat -c '%u' cast-bridge/data 2>/dev/null || echo '')"
if [[ -n "$cast_dir_uid" && "$cast_dir_uid" != "1000" ]]; then
  if ! chown 1000:1000 cast-bridge/data 2>/dev/null; then
    echo "  WARNING: infra/cast-bridge/data is owned by uid $cast_dir_uid, but the bridge runs as uid 1000." >&2
    echo "  Pairing keys will not persist and the TV will ask for permission on every cast. Fix with:" >&2
    echo "    sudo chown -R 1000:1000 infra/cast-bridge/data" >&2
  fi
fi

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
#
# cast-bridge is here for the SAME reason, and it had the SAME bug: this line
# listed only bff and music-worker, so "ver en la tele" shipped a service that
# was never started on any deploy. The BFF still got its CAST_BRIDGE_URL, dialed
# the gateway, found nobody listening, and — by the deliberate design in
# bff/cast.mjs — answered `{ devices: [] }` with HTTP 200. The player screen then
# said "No encontramos ningún dispositivo" forever while this script printed
# "deploy OK". Graceful degradation upstream is exactly what makes leaving this
# service out of the build line invisible, which is why the smoke test below
# probes the bridge's own /healthz and not just the BFF route.
docker compose up -d --build bff music-worker cast-bridge
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
# Modo gamer, probed for real. The two checks above only cover / and /radarr,
# which is exactly how editing music-worker used to produce a silent no-op that
# still printed "deploy OK" (see the comment on the build line above). The
# EmulatorJS loader proves the runtime survived the infra/www swap; the BFF
# route proves the games handler is in the running image — 401 is the SUCCESS
# case here, same boundary logic as /radarr, since the smoke test holds no
# session. A 404 means the image predates the route.
ejs=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/emulatorjs/data/loader.js || echo 000)
gam=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/bff/games/library || echo 000)
# Box art, probed separately from /library for the same reason /library is
# probed separately from /radarr: the two routes ship in the same image but a
# 401 here and a 404 there is the only signal that tells "the cover endpoint is
# live" apart from "this image predates it and every shelf is placeholders".
cov=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://localhost:8600/bff/games/cover?id=x' || echo 000)
echo "  /                        -> $home"
echo "  /radarr/api/v3/queue     -> $arr"
echo "  /emulatorjs/data/loader.js -> $ejs (expect 200)"
echo "  /bff/games/library       -> $gam (expect 401)"
echo "  /bff/games/cover         -> $cov (expect 401)"
[[ "$ejs" == "200" ]] || { echo "  WARNING: EmulatorJS runtime not served — modo gamer will not load." >&2; emulatorjs_ok=0; }
[[ "$gam" == "401" ]] || echo "  WARNING: /bff/games/library answered $gam, expected 401 — is the BFF image stale?" >&2
[[ "$cov" == "401" ]] || echo "  WARNING: /bff/games/cover answered $cov, expected 401 — no box art in this image." >&2
# "Ver en la tele", probed on BOTH halves, because either half can be dead while
# the other looks perfect. Same boundary logic as /radarr and /bff/games: 401 is
# the SUCCESS case, the smoke test holds no session, and a 404 means the BFF
# image predates the cast route.
#
# The second check is the one that matters here, and it is not redundant. The
# BFF answers `{ devices: [] }` with HTTP 200 when the bridge is missing,
# unreachable or still booting — that is a deliberate contract (bff/cast.mjs),
# not a bug — so /bff/cast/devices reports 401-then-200 just as happily with NO
# cast-bridge running at all. That is precisely how this service shipped for a
# whole feature without ever being started. /healthz is answered by the bridge
# process itself and depends on no television being powered on, so it separates
# "the bridge is down" (000/connection refused) from "the bridge is up and the
# TVs are off" (200, empty list) — the distinction the front-end cannot make.
#
# The address is read back from `docker compose config`, NOT parsed out of .env
# by hand. Hand-parsing was tried and is wrong: an inline comment
# (`CAST_GATEWAY_IP=172.19.0.1 # media-automation`), surrounding quotes, a
# trailing space or a CRLF line ending all survive a naive `awk -F=` and none of
# them survive compose's own parser. The bridge would bind correctly while this
# check built `http://172.19.0.1 # media-automation:8791/healthz`, got 000, and
# reported a perfectly healthy service as down — a FALSE alarm on a good deploy,
# which is how a check stops being believed. Asking compose deletes the second
# parser entirely: this is literally the string the container binds to.
#
# `|| true` is load-bearing under `set -o pipefail`: a missing infra/.env makes
# compose exit non-zero (DATA_DIR is `:?`-required), and without it errexit
# would kill the whole deploy right here with no message at all.
cast_gw="$(docker compose config 2>/dev/null | awk '/CAST_BRIDGE_BIND:/ { print $2; exit }' | tr -d "\"'" || true)"
# Falls back to the same ${CAST_GATEWAY_IP:-172.19.0.1} default docker-compose.yml
# uses, for the case where compose itself could not be read.
cast_gw="${cast_gw:-172.19.0.1}"
cast_ok=1
cast_route=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8600/bff/cast/devices || echo 000)
cast_health=000
# Retried for the same reason as /radarr above: a freshly (re)built bridge may
# still be binding its socket, and a one-shot check would report a healthy
# service as dead on every deploy that actually rebuilt it.
for i in $(seq 1 10); do
  cast_health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${cast_gw}:8791/healthz" || echo 000)
  [[ "$cast_health" == "200" ]] && break
  sleep 1
done
echo "  /bff/cast/devices        -> $cast_route (expect 401)"
echo "  cast-bridge /healthz     -> $cast_health (expect 200, at $cast_gw:8791)"
[[ "$cast_route" == "401" ]] || echo "  WARNING: /bff/cast/devices answered $cast_route, expected 401 — is the BFF image stale?" >&2
[[ "$cast_health" == "200" ]] || cast_ok=0
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

if [[ "$cast_ok" != "1" ]]; then
  echo "  WARNING: cast-bridge is not answering on $cast_gw:8791 — 'ver en la tele' will show" >&2
  echo "  \"No encontramos ningún dispositivo\" no matter how many TVs are on, because the BFF" >&2
  echo "  degrades to an empty list when the bridge is unreachable. Everything else deployed" >&2
  echo "  normally. Look at it with:" >&2
  echo "    docker compose logs --tail=50 cast-bridge" >&2
  echo "  A wrong gateway address is the usual cause — check CAST_GATEWAY_IP in infra/.env" >&2
  echo "  against: docker network inspect infra_media-automation" >&2
fi

if [[ "$emulatorjs_ok" != "1" ]]; then
  echo "  WARNING: the EmulatorJS runtime is missing or incomplete — /emulatorjs/* will 404" >&2
  echo "  and 'modo gamer' will not load. Everything else deployed normally. Retry with:" >&2
  echo "    ./infra/fetch-emulatorjs.sh --force" >&2
fi

# Appended to whichever summary line prints below, so a dead bridge lands on the
# LAST line of the deploy — the one anybody actually reads — and not only in a
# warning that scrolled past twenty lines of Funnel output. Casting is optional
# by design (no depends_on, the BFF degrades to an empty list), so this is NOT
# exit 1. But a warning on stderr followed by a flat "deploy OK" on stdout is
# precisely the shape of the lie this file keeps collecting comments about, and
# the summary must not be green while the feature is dead.
cast_note=''
if [[ "$cast_ok" != "1" ]]; then
  cast_note=' — CASTING IS DOWN (see above)'
fi

if [[ "$ok" != "1" ]]; then
  exit 1
elif [[ "$pub" == "skipped" ]]; then
  # Never claim the public path is up when nothing proved it.
  echo "==> deploy OK locally — PUBLIC PATH UNVERIFIED (see above)$cast_note"
else
  echo "==> deploy OK (local + public)$cast_note"
fi
