#!/usr/bin/env bash
# Fetch the browser-side EmulatorJS runtime that "modo gamer" loads.
#
# 289 MB of cores and wasm blobs, deliberately NOT in git: it is a versioned
# third-party release, identical for everyone, and cloning the repo should not
# cost a third of a gigabyte. Caddy serves infra/www as /srv, so once this has
# run the whole thing is reachable at /emulatorjs/* (see the dedicated handle
# block in infra/Caddyfile).
#
#   ./infra/fetch-emulatorjs.sh          # idempotent: does nothing if present
#   ./infra/fetch-emulatorjs.sh --force  # re-download and re-extract
#
# infra/deploy.sh calls this on every deploy, and it MUST: the deploy replaces
# the whole infra/www directory (`mv infra/www infra/www.bak && cp -r dist
# infra/www`), which carries EmulatorJS off with the previous bundle. The
# extracted release is therefore kept in its own cache OUTSIDE infra/www, and
# putting it back is a hardlink copy rather than a 289 MB download.
set -euo pipefail

VERSION="4.2.3"
URL="https://github.com/EmulatorJS/EmulatorJS/releases/download/v${VERSION}/${VERSION}.7z"
# Observed on a verified download of this exact asset, NOT published upstream —
# EmulatorJS ships no checksum file. It pins what we actually installed and
# reviewed. The length check below only proves the transfer completed; this is
# what makes a re-tagged or tampered release fail loudly instead of landing
# 289 MB of third-party JS and wasm in the public web root. On a version bump
# this MUST be recomputed:
#   curl -fsL <url> | sha256sum
EXPECTED_SHA256="07d451bc06fa3ad04ab30d9b94eb63ac34ad0babee52d60357b002bde8f3850b"

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$INFRA/.emulatorjs/$VERSION"   # extracted release, survives deploys
ARCHIVE="$INFRA/.emulatorjs/${VERSION}.7z"
TARGET="$INFRA/www/emulatorjs"        # what Caddy actually serves

# The loader is the documented entry point (`<script src=".../data/loader.js">`),
# so an extraction without it is useless no matter what else it contains.
SENTINEL="data/loader.js"
# Written LAST, after the tree is fully in place. The sentinel alone cannot
# answer "is this complete?" — it is one file out of thousands, and an earlier
# version of this script used it as the skip check, so a publish interrupted
# after loader.js was linked left a one-file directory that every later run
# happily declared "already in place", permanently. The stamp is only ever
# created on a finished tree, and it carries the version so a bump republishes.
STAMP=".emulatorjs-version"

force=0
[[ "${1:-}" == "--force" ]] && force=1

if [[ "$force" == "0" && -f "$TARGET/$SENTINEL" && "$(cat "$TARGET/$STAMP" 2>/dev/null)" == "$VERSION" ]]; then
  echo "==> EmulatorJS $VERSION already in place ($TARGET)"
  exit 0
fi

[[ "$force" == "1" ]] && rm -rf "$CACHE" "$ARCHIVE"

# ---- 1. cache: download + extract, once per version ------------------------
if [[ ! -f "$CACHE/$SENTINEL" ]]; then
  # 7z is not a build dependency of anything else here, so say so plainly
  # instead of failing inside a pipe with "command not found".
  SEVENZIP=""
  for candidate in 7zz 7z 7za; do
    if command -v "$candidate" >/dev/null 2>&1; then SEVENZIP="$candidate"; break; fi
  done
  if [[ -z "$SEVENZIP" ]]; then
    echo "need a 7z extractor (7zz, 7z or 7za) to unpack the EmulatorJS release." >&2
    echo "  Debian/Ubuntu: sudo apt-get install -y p7zip-full" >&2
    echo "  Alpine:        apk add p7zip" >&2
    echo "  macOS:         brew install sevenzip" >&2
    exit 1
  fi

  mkdir -p "$INFRA/.emulatorjs"
  rm -rf "$CACHE" "$CACHE.tmp"

  # Expected size first, from a HEAD that follows the redirect to GitHub's
  # asset CDN. curl already fails a short read with CURLE_PARTIAL_FILE, but
  # only when the server bothered to send Content-Length; a proxy that streams
  # the body chunked and dies mid-way leaves a truncated .7z that 7z will
  # happily extract *partially*, which is the failure this whole check exists
  # to catch. A half-extracted core is a black screen, not an error message.
  expected="$(curl -sSfIL --max-time 60 "$URL" \
    | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }')" || expected=""

  echo "==> downloading EmulatorJS $VERSION (${expected:-size unknown} bytes)"
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$ARCHIVE.part" "$URL"

  actual="$(wc -c < "$ARCHIVE.part" | tr -d ' ')"
  if [[ -n "$expected" && "$expected" != "$actual" ]]; then
    rm -f "$ARCHIVE.part"
    echo "TRUNCATED download: expected $expected bytes, got $actual. Nothing was installed." >&2
    exit 1
  fi
  if [[ -z "$expected" ]]; then
    echo "  note: the server sent no Content-Length, so the size could not be cross-checked;" >&2
    echo "  only curl's own short-read detection and the checksum below covered this." >&2
  fi

  # Integrity, not just completeness. A download can arrive at exactly the
  # advertised length and still not be the artifact that was reviewed.
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$ARCHIVE.part" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$ARCHIVE.part" | awk '{print $1}')"
  else
    got=""
    echo "  note: no sha256sum/shasum available, checksum NOT verified." >&2
  fi
  if [[ -n "$got" && "$got" != "$EXPECTED_SHA256" ]]; then
    rm -f "$ARCHIVE.part"
    echo "CHECKSUM MISMATCH for $URL" >&2
    echo "  expected $EXPECTED_SHA256" >&2
    echo "  got      $got" >&2
    echo "Nothing was installed. If the upstream release was legitimately re-cut," >&2
    echo "review the new contents and update EXPECTED_SHA256 in this script." >&2
    exit 1
  fi

  mv "$ARCHIVE.part" "$ARCHIVE"

  echo "==> extracting"
  mkdir -p "$CACHE.tmp"
  "$SEVENZIP" x -y -o"$CACHE.tmp" "$ARCHIVE" >/dev/null

  # Releases have shipped both flat (`data/…`) and wrapped in a single
  # top-level directory (`4.2.3/data/…`). Normalise instead of pinning to
  # whichever layout this version happens to use, so a future bump does not
  # silently produce /emulatorjs/4.2.3/data/loader.js.
  if [[ ! -d "$CACHE.tmp/data" ]]; then
    inner="$(find "$CACHE.tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [[ -n "$inner" && -d "$inner/data" ]]; then
      mv "$inner" "$CACHE.staged"
      rm -rf "$CACHE.tmp"
      mv "$CACHE.staged" "$CACHE.tmp"
    fi
  fi
  if [[ ! -f "$CACHE.tmp/$SENTINEL" ]]; then
    rm -rf "$CACHE.tmp"
    echo "extracted archive has no $SENTINEL — refusing to install a broken runtime." >&2
    exit 1
  fi

  # Only now is the cache valid: an interrupted run leaves .tmp behind and the
  # next one starts over, rather than leaving a half-populated $CACHE that the
  # sentinel check above would wave through.
  mv "$CACHE.tmp" "$CACHE"

  # The .7z has no reader left — the extracted tree is the cache, and --force
  # re-downloads from scratch anyway. Keeping it would park a second 289 MB on
  # a home server's disk forever for nothing.
  rm -f "$ARCHIVE"
fi

# ---- 2. publish into the directory Caddy serves ----------------------------
# Built beside the target and moved into place, never assembled in place. The
# in-place version had a real window: `rm -rf $TARGET` followed by a multi-
# thousand-file copy meant any interruption — and deploy.sh's own header notes
# this box has powered itself off under load — left a partial directory that
# the skip check then blessed forever. Here an interruption leaves `.new`
# behind and the next run starts over.
#
# `cp -al` hardlinks: same filesystem, so this is instant and costs no extra
# disk even though the deploy keeps a whole previous bundle in infra/www.bak.
# The fallback is for the case where infra/www lives on a different mount.
echo "==> publishing EmulatorJS $VERSION into $TARGET"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
cp -al "$CACHE/." "$TARGET.new/" 2>/dev/null || cp -R "$CACHE/." "$TARGET.new/"

[[ -f "$TARGET.new/$SENTINEL" ]] || { echo "publish failed: $SENTINEL missing" >&2; exit 1; }
# The stamp goes on only now, so its presence means the whole tree landed.
echo "$VERSION" > "$TARGET.new/$STAMP"

rm -rf "$TARGET.old"
[[ -d "$TARGET" ]] && mv "$TARGET" "$TARGET.old"
mv "$TARGET.new" "$TARGET"
rm -rf "$TARGET.old"

echo "==> EmulatorJS $VERSION ready at /emulatorjs/"
