# poisonflix-music-worker — YouTube Music -> Jellyfin audio downloader.
# Python + ffmpeg + yt-dlp (download) + ytmusicapi (clean song metadata) +
# mutagen (authoritative m4a re-tagging). Internal only; no published ports.
FROM python:3.12-slim

# ffmpeg: yt-dlp audio extraction / m4a mux + thumbnail embed. gosu: drop to
# the Jellyfin PUID/PGID at runtime so downloaded files are readable by Jellyfin.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg gosu curl unzip \
    && rm -rf /var/lib/apt/lists/*

# deno: yt-dlp needs a JavaScript runtime to run YouTube's player script for
# signature deciphering. Without one it logs "No supported JavaScript runtime
# could be found ... some formats may be missing" and takes a deprecated path, so
# the worker was extracting from a reduced format list. It must be deno
# specifically — this yt-dlp only auto-enables that one, and `--js-runtimes node`
# was tested against a nodejs install and still warned.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- --yes \
    && deno --version

# ytmusicapi/mutagen are pinned for reproducibility. yt-dlp is deliberately NOT
# pinned: YouTube breaks old extractors constantly, so a stale pin makes every
# download fail ("Requested format is not available"). We install the latest at
# build time AND self-update it on container start (see entrypoint.sh).
#
# ytmusicapi scrapes the same internal API and rots the same way — the 1.8.2 pin
# proved it. YouTube reshaped the watch-next response and 1.8.2 started raising
# KeyError: 'endpoint' from parsers/watch.py, so get_watch_playlist — the radio's
# main source — threw on every call. The radio silently fell back to replaying
# the listener's own history, which is exactly what it felt like from outside.
# It stays pinned (an API change here breaks server.py, unlike a yt-dlp bump),
# but the pin needs reviewing whenever the radio starts feeling stale. 1.12.1 was
# verified against every call this worker makes: search, get_song,
# get_song_related, get_watch_playlist, get_home, get_album, get_playlist.
# Note: `limit` is a paging floor in 1.9+, not a hard cap — expect more results
# than requested and slice where an exact count matters.
RUN pip install --no-cache-dir \
    "yt-dlp" \
    "ytmusicapi==1.12.1" \
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
