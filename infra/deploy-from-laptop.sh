#!/usr/bin/env bash
# Build on THIS machine, ship dist/ to the server, deploy there without
# rebuilding Vite.
#
# Why this exists: infra/deploy.sh's default path runs `npm ci && npm run
# build` (Vite) plus two `docker build`s ON THE SERVER. That server is a
# Gigabyte AB350M-DS3H desktop board, not a build farm, and it has already
# blacked out under load twice — once mid-deploy (see project memory:
# "mendezserver se apaga bajo carga"). The Vite build is the single heaviest
# step in that pipeline. This script moves ONLY that step to the laptop:
#
#   STILL runs on the server (unchanged): `git pull`, `docker build` for
#     bff and music-worker (their source is baked into the image, not
#     bind-mounted, so the server needs the updated checkout regardless),
#     the Caddy/tailscale recreate+restart dance, and both smoke tests.
#   MOVED to the laptop: `npm ci && npm run build`. Its output (dist/) is
#     rsynced to the server's checkout, then infra/deploy.sh runs there
#     with --no-build so it reuses that dist/ instead of rebuilding it.
#
# Usage (run from the laptop, in this repo):
#   ./infra/deploy-from-laptop.sh
#
# This script does NOT support --rollback — that only touches infra/www.bak,
# which already lives on the server. Run it there directly:
#   ssh mendez@mendezserver 'bash -lc "cd ~/poisonflix-workspace/poisonflix-web && ./infra/deploy.sh --rollback"'
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

SERVER_HOST="mendez@mendezserver"
# Relative to mendez's $HOME on the server — matches how ssh/rsync land
# without needing tilde-expansion tricks (scp/rsync remote paths are already
# relative to $HOME when they don't start with /).
SERVER_REPO_REL="poisonflix-workspace/poisonflix-web"
# BatchMode=yes: fail fast on a key/auth problem instead of hanging on a
# password prompt that will never be answered from a script.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

# `bash -lc` is NOT optional here: over a direct, non-interactive ssh command
# the remote shell is non-login, and mendez's npm/node/git live in
# ~/.local/bin, which only gets onto PATH via a LOGIN shell's profile.
# Without `-l` this dies immediately on the server with `npm: command not
# found` (see project memory: "El gotcha que importa" in
# desplegar-en-mendezserver). `printf %q` quotes the whole remote command as
# one safely-escaped argument so it survives the ssh -> bash -lc -> shell
# round trip intact.
remote() {
  ssh "${SSH_OPTS[@]}" "$SERVER_HOST" "bash -lc $(printf '%q' "$1")"
}

echo "==> preflight: local git state"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository: $REPO" >&2
  exit 1
fi

# vite.config.ts's buildStamp() reads `git rev-parse --short HEAD` on THIS
# machine at build time and bakes it into __PF_BUILD__, which the app shows
# on-screen so anyone can tell which commit is actually running (see that
# file's comment on the night lost to not knowing which code was live). A
# dirty working tree would make that stamp point at a commit that isn't
# actually what got built, defeating the whole point of the stamp.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is dirty — commit or stash before building here." >&2
  echo "A laptop build stamps __PF_BUILD__ with HEAD (vite.config.ts); building" >&2
  echo "with uncommitted changes would ship a bundle whose visible build id" >&2
  echo "lies about what's actually running." >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" ]]; then
  echo "detached HEAD — check out a branch first (the server tracks a branch via 'git pull')." >&2
  exit 1
fi
local_sha="$(git rev-parse HEAD)"

echo "==> preflight: server is on the same branch ($branch)?"
server_branch="$(remote "cd ~/$SERVER_REPO_REL && git rev-parse --abbrev-ref HEAD")"
if [[ "$server_branch" != "$branch" ]]; then
  echo "server is on '$server_branch', laptop is on '$branch' — aborting." >&2
  echo "Check out the same branch on both sides before deploying from the laptop." >&2
  exit 1
fi

echo "==> preflight: local HEAD matches origin/$branch?"
# The server updates via 'git pull' FROM ORIGIN, not from this laptop
# directly. If local HEAD were ahead of (or diverged from) origin, the
# dist/ we're about to build would be stamped with a commit the server can
# never actually pull, so the on-screen build id would lie about what the
# server is running the moment anyone looks.
git fetch origin "$branch" --quiet
origin_sha="$(git rev-parse "origin/$branch" 2>/dev/null || true)"
if [[ -z "$origin_sha" ]]; then
  echo "origin/$branch not found after fetch — push the branch first." >&2
  exit 1
fi
if [[ "$local_sha" != "$origin_sha" ]]; then
  echo "local HEAD ($local_sha) != origin/$branch ($origin_sha)." >&2
  echo "Push (or pull) so this laptop builds the exact commit the server will pull." >&2
  exit 1
fi

echo "==> building web locally (commit $local_sha)"
npm ci
npm run build

# Same phantom-bundle guard as infra/deploy.sh --no-build, checked here too
# so a broken local build is caught before spending time on rsync/ssh.
if [[ ! -d dist ]] || [[ -z "$(ls -A dist 2>/dev/null)" ]]; then
  echo "npm run build produced no dist/ — aborting before touching the server." >&2
  exit 1
fi

echo "==> updating server checkout (git pull --ff-only)"
# Needed even though Vite no longer builds here: infra/bff and
# infra/music-worker bake their source INTO their Docker images (see
# infra/deploy.sh's comment on why both must be rebuilt), so the server
# still needs the fresh checkout to build those images from. --ff-only
# refuses to create a merge commit that would drift the server off the exact
# commit we just verified matches origin above.
remote "cd ~/$SERVER_REPO_REL && git fetch origin && git pull --ff-only"

echo "==> verifying server HEAD matches laptop HEAD after pull"
remote_sha="$(remote "cd ~/$SERVER_REPO_REL && git rev-parse HEAD")"
if [[ "$remote_sha" != "$local_sha" ]]; then
  echo "server HEAD ($remote_sha) != laptop HEAD ($local_sha) after pull — aborting." >&2
  echo "Someone likely pushed to origin/$branch between the check above and now; re-run this script." >&2
  exit 1
fi

echo "==> shipping dist/ to $SERVER_HOST:$SERVER_REPO_REL/dist/"
# --delete: infra/deploy.sh's --no-build path fails loudly on an empty dist/,
# but it can't detect a STALE one — a laptop bundle laid on top of leftover
# files from a previous build without --delete would look complete and ship
# a mix of two commits.
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" dist/ "$SERVER_HOST:$SERVER_REPO_REL/dist/"

echo "==> running infra/deploy.sh --no-build on the server"
remote "cd ~/$SERVER_REPO_REL && ./infra/deploy.sh --no-build"
