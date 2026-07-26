# poisonflix-music-worker — YouTube Music -> Jellyfin audio downloader.
# Python + ffmpeg + yt-dlp (download) + ytmusicapi (clean song metadata) +
# mutagen (authoritative m4a re-tagging). Internal only; no published ports.
FROM python:3.12-slim

# ffmpeg: yt-dlp audio extraction / m4a mux + thumbnail embed. gosu: drop to
# the Jellyfin PUID/PGID at runtime so downloaded files are readable by Jellyfin.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg gosu \
    && rm -rf /var/lib/apt/lists/*

# ytmusicapi/mutagen are pinned for reproducibility. yt-dlp is deliberately NOT
# pinned: YouTube breaks old extractors constantly, so a stale pin makes every
# download fail ("Requested format is not available"). We install the latest at
# build time AND self-update it on container start (see entrypoint.sh).
RUN pip install --no-cache-dir \
    "yt-dlp" \
    "ytmusicapi==1.8.2" \
    "mutagen==1.47.0"

WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV PORT=8790 \
    MUSIC_DIR=/media/Music \
    DATA_DIR=/data \
    PYTHONUNBUFFERED=1

EXPOSE 8790
ENTRYPOINT ["./entrypoint.sh"]
