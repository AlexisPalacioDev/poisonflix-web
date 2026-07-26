#!/bin/sh
# Run the worker as Jellyfin's PUID/PGID so files land in /media/Music with an
# ownership Jellyfin can read. Defaults to 1000:1000 (the common linuxserver id).
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p /data /data/.cache /media/Music
# State + yt-dlp cache must be writable by the runtime user. /media itself is
# owned by Jellyfin, but the Music subdir is created HERE (as root) the first
# time, so it must be chowned to the runtime user or downloads hit EACCES.
chown -R "${PUID}:${PGID}" /data 2>/dev/null || true
chown "${PUID}:${PGID}" /media/Music 2>/dev/null || true

# yt-dlp rots fast against YouTube changes. Best-effort self-update on start so a
# long-running container keeps working without an image rebuild; ignore failures
# (offline start) and fall back to the version baked into the image.
pip install --no-cache-dir -U yt-dlp 2>/dev/null || true

export HOME=/data
export XDG_CACHE_HOME=/data/.cache

exec gosu "${PUID}:${PGID}" python server.py
