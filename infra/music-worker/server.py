#!/usr/bin/env python3
"""poisonflix-music-worker — internal audio download service.

The only component that holds a JELLYFIN_API_KEY for music: it searches
YouTube Music (ytmusicapi, unauthenticated), downloads best audio with yt-dlp,
authoritatively rewrites tags with mutagen so Jellyfin groups Artist/Album/Track
cleanly, and triggers debounced Jellyfin library scans. Never public — only the
BFF (on the same docker network) reaches it, and the BFF authenticates every
caller against their Jellyseerr session first.

Zero web framework: Python stdlib http.server, mirroring the BFF's zero-dep
Node style. Download queue is FIFO, concurrency 1.
"""

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("PORT", "8790"))
MUSIC_DIR = os.environ.get("MUSIC_DIR", "/media/Music")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
JELLYFIN_URL = os.environ.get("JELLYFIN_URL", "http://jellyfin-ts:8096").rstrip("/")
JELLYFIN_API_KEY = os.environ.get("JELLYFIN_API_KEY", "")

JOBS_PATH = os.path.join(DATA_DIR, "jobs.json")
MANIFEST_PATH = os.path.join(DATA_DIR, "downloaded.json")
BATCHES_PATH = os.path.join(DATA_DIR, "batches.json")
RATINGS_PATH = os.path.join(DATA_DIR, "ratings.json")

DOWNLOAD_TIMEOUT_S = 300  # ~5 min hard cap per yt-dlp run, then the job fails.
MAX_JOBS_KEPT = 100  # recent-jobs cap returned by GET /downloads
REFRESH_DEBOUNCE_S = 5.0

DEFAULT_ARTIST = "Desconocido"
DEFAULT_ALBUM = "Sencillos"

# ---------------------------------------------------------------------------
# State (guarded by _lock) + persistence
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_jobs = {}  # jobId -> job dict
_job_order = []  # insertion order of jobIds (for the recent-jobs cap)
_downloaded = set()  # videoIds already on disk (dedup manifest)
_active_by_video = {}  # videoId -> jobId currently queued/downloading (coalesce)
_download_queue = queue.Queue()
_batches = {}  # batchId -> {"jobIds": [...], "createdAt": int}
_batch_order = []  # insertion order of batchIds (for the recent-batches cap)

MAX_BATCHES_KEPT = 50  # recent-batches cap before eviction

_refresh_timer = None
_ytmusic = None  # lazily constructed YTMusic client

# --- Instant-play (stream without download) + already-downloaded detection ----
# Resolved googlevideo audio URLs, cached so repeat plays skip the ~1-2s yt-dlp
# resolve. videoId -> (direct_url, expiry_monotonic).
_stream_lock = threading.Lock()
_stream_cache = {}
STREAM_URL_TTL = 300.0  # 5 min; googlevideo URLs live hours, re-resolve is cheap

# videoId -> Jellyfin itemId, derived from the "[videoId].ext" tail every
# downloaded file carries (see target_path). Cached briefly so a burst of
# searches makes at most one Jellyfin call.
_lib_lock = threading.Lock()
_lib_index = {"map": {}, "ts": 0.0}
LIB_INDEX_TTL = 30.0
_VIDEO_IN_PATH = re.compile(r"\[([A-Za-z0-9_-]{6,})\]\.[A-Za-z0-9]+$")


def _load_state():
    os.makedirs(DATA_DIR, exist_ok=True)
    _load_ratings()
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
            _downloaded.update(json.load(fh))
    except (FileNotFoundError, ValueError):
        pass
    try:
        with open(JOBS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for job in data:
            _jobs[job["id"]] = job
            _job_order.append(job["id"])
    except (FileNotFoundError, ValueError, KeyError):
        pass
    try:
        with open(BATCHES_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for batch_id, batch in data.items():
            _batches[batch_id] = batch
            _batch_order.append(batch_id)
    except (FileNotFoundError, ValueError, AttributeError):
        pass


# ---------------------------------------------------------------------------
# Ratings: thumbs up / down, per user, keyed by videoId.
#
# Jellyfin can already store a rating -- but only for items in the library, and
# the tracks a user most wants to reject are exactly the ones that are NOT
# there: radio suggestions they never downloaded. Those have no Jellyfin item to
# hang a rating on, so the videoId is the only stable key that covers both, and
# this file is the single source of truth for both.
#
# Shape: {userId: {videoId: 1 | -1}}. A cleared vote drops the key rather than
# storing 0, so the file stays a record of opinions actually held.
# ---------------------------------------------------------------------------

_ratings = {}
_ratings_lock = threading.Lock()


def _load_ratings():
    global _ratings
    try:
        with open(RATINGS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            _ratings = {
                str(uid): {str(v): int(r) for v, r in (votes or {}).items() if int(r) in (1, -1)}
                for uid, votes in data.items()
                if isinstance(votes, dict)
            }
    except (FileNotFoundError, ValueError, AttributeError, TypeError):
        _ratings = {}


def _persist_ratings():
    # Called under _ratings_lock. Best-effort, mirrors _persist_jobs.
    try:
        tmp = RATINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_ratings, fh)
        os.replace(tmp, RATINGS_PATH)
    except OSError:
        pass


def user_ratings(user_id):
    """This user's votes. Anonymous callers get an empty, read-only view rather
    than sharing one global bucket -- ratings are personal by definition."""
    if not user_id:
        return {}
    with _ratings_lock:
        return dict(_ratings.get(user_id, {}))


def set_rating(user_id, video_id, rating):
    """rating: 1 (up), -1 (down), or 0 to clear. Returns the stored value."""
    if not user_id or not video_id:
        return 0
    with _ratings_lock:
        votes = _ratings.setdefault(user_id, {})
        if rating in (1, -1):
            votes[video_id] = rating
        else:
            votes.pop(video_id, None)
            if not votes:
                _ratings.pop(user_id, None)
        _persist_ratings()
    return rating if rating in (1, -1) else 0


def _annotate_ratings(results, user_id):
    """Tags each song with this user's vote so the row can render its state."""
    votes = user_ratings(user_id)
    if not votes:
        return results
    for r in results:
        if r.get("type") == "song":
            r["rating"] = votes.get(r.get("videoId"), 0)
    return results


def _drop_disliked(results, user_id):
    """Removes thumbed-down songs. This is what makes the vote mean something:
    a dislike that still shows up in the next radio is a button that lied."""
    votes = user_ratings(user_id)
    if not votes:
        return results
    return [
        r
        for r in results
        if not (r.get("type") == "song" and votes.get(r.get("videoId")) == -1)
    ]


def _persist_jobs():
    # Called under _lock. Best-effort — a failed write must never crash a job.
    try:
        recent = [_jobs[jid] for jid in _job_order[-MAX_JOBS_KEPT:] if jid in _jobs]
        tmp = JOBS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(recent, fh)
        os.replace(tmp, JOBS_PATH)
    except OSError:
        pass


def _persist_manifest():
    try:
        tmp = MANIFEST_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(sorted(_downloaded), fh)
        os.replace(tmp, MANIFEST_PATH)
    except OSError:
        pass


def _persist_batches():
    # Called under _lock. Best-effort, mirrors _persist_jobs.
    try:
        recent = {bid: _batches[bid] for bid in _batch_order[-MAX_BATCHES_KEPT:] if bid in _batches}
        tmp = BATCHES_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(recent, fh)
        os.replace(tmp, BATCHES_PATH)
    except OSError:
        pass


def _set_state(job_id, state, **fields):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["state"] = state
        job.update(fields)
        _persist_jobs()


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def sanitize_segment(value, fallback):
    """A single filesystem-safe path segment (no separators, trimmed)."""
    if not value or not str(value).strip():
        return fallback
    cleaned = _ILLEGAL.sub("_", str(value)).strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned[:120].strip()
    return cleaned or fallback


def target_dir(artist, album):
    return os.path.join(
        MUSIC_DIR,
        sanitize_segment(artist, DEFAULT_ARTIST),
        sanitize_segment(album, DEFAULT_ALBUM),
    )


def target_path(artist, album, title, video_id):
    name = f"{sanitize_segment(title, video_id)} [{video_id}].m4a"
    return os.path.join(target_dir(artist, album), name)


# ---------------------------------------------------------------------------
# Search (ytmusicapi, unauthenticated) with yt-dlp fallback
# ---------------------------------------------------------------------------

def _get_ytmusic():
    global _ytmusic
    if _ytmusic is None:
        from ytmusicapi import YTMusic

        _ytmusic = YTMusic()
    return _ytmusic


def _first_thumb(thumbnails):
    if not thumbnails:
        return None
    # ytmusicapi returns ascending resolution; prefer the largest.
    return thumbnails[-1].get("url")


def _item_thumbs(item):
    """Return an item's thumbnail list regardless of ytmusicapi's key name.

    Search results carry `thumbnails`; watch-playlist tracks carry `thumbnail`
    (both are ascending-resolution lists). Accept either so every mapped item
    can resolve a non-null thumbnailUrl when the source provides one."""
    return item.get("thumbnails") or item.get("thumbnail")


def _map_song(item):
    artists = [a.get("name") for a in (item.get("artists") or []) if a.get("name")]
    album = item.get("album") or {}
    album_name = album.get("name") if isinstance(album, dict) else None
    return {
        "type": "song",
        "videoId": item.get("videoId"),
        "title": item.get("title"),
        "artist": artists[0] if artists else None,
        "artists": artists,
        "album": album_name,
        "durationSeconds": item.get("duration_seconds"),
        "thumbnailUrl": _first_thumb(_item_thumbs(item)),
        "source": "ytmusic",
    }


def _map_album(item):
    """Map an ytmusicapi `search(filter="albums")` result to a typed Item."""
    artists = [a.get("name") for a in (item.get("artists") or []) if a.get("name")]
    return {
        "type": "album",
        "browseId": item.get("browseId"),
        "title": item.get("title"),
        "artist": artists[0] if artists else None,
        "thumbnailUrl": _first_thumb(_item_thumbs(item)),
        "trackCount": _coerce_count(item.get("trackCount") or item.get("itemCount")),
        "year": item.get("year"),
    }


def _playlist_author(item):
    author = item.get("author")
    if isinstance(author, list):
        names = [a.get("name") for a in author if isinstance(a, dict) and a.get("name")]
        return names[0] if names else None
    if isinstance(author, dict):
        return author.get("name")
    if isinstance(author, str):
        return author
    return None


def _coerce_count(value):
    """Normalize an ytmusicapi count ("50", "50 songs", 50) into an int/None."""
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        m = re.search(r"\d[\d,]*", value)
        if m:
            try:
                return int(m.group(0).replace(",", ""))
            except ValueError:
                return None
    return None


def _map_playlist(item):
    """Map an ytmusicapi `search(filter="playlists")` result to a typed Item.

    get_playlist expects a bare playlistId; search returns it either as
    `playlistId` or as a `browseId` with a leading "VL" — normalize to bare."""
    pid = item.get("playlistId") or item.get("browseId")
    if isinstance(pid, str) and pid.startswith("VL"):
        pid = pid[2:]
    return {
        "type": "playlist",
        "playlistId": pid,
        "title": item.get("title"),
        "author": _playlist_author(item),
        "thumbnailUrl": _first_thumb(_item_thumbs(item)),
        "trackCount": _coerce_count(item.get("itemCount") or item.get("trackCount")),
    }


def _ytmusic_songs(query, limit):
    yt = _get_ytmusic()
    results = []
    for item in yt.search(query, filter="songs", limit=limit):
        if item.get("videoId"):
            results.append(_map_song(item))
    return results[:limit]


def _ytmusic_videos(query, limit):
    # YT Music "videos" surface (still clean-ish, artist=uploader).
    yt = _get_ytmusic()
    results = []
    for item in yt.search(query, filter="videos", limit=limit):
        if not item.get("videoId"):
            continue
        artists = [a.get("name") for a in (item.get("artists") or []) if a.get("name")]
        results.append(
            {
                "type": "song",
                "videoId": item.get("videoId"),
                "title": item.get("title"),
                "artist": artists[0] if artists else None,
                "artists": artists,
                "album": None,
                "durationSeconds": item.get("duration_seconds"),
                "thumbnailUrl": _first_thumb(_item_thumbs(item)),
                "source": "youtube",
            }
        )
    return results[:limit]


def _ytmusic_albums(query, limit):
    yt = _get_ytmusic()
    results = []
    for item in yt.search(query, filter="albums", limit=limit):
        if item.get("browseId"):
            results.append(_map_album(item))
    return results[:limit]


def _ytmusic_playlists(query, limit):
    yt = _get_ytmusic()
    results = []
    for item in yt.search(query, filter="playlists", limit=limit):
        mapped = _map_playlist(item)
        if mapped.get("playlistId"):
            results.append(mapped)
    return results[:limit]


# Caps per typed section on the ytmusic/auto search surface.
SONG_CAP = 8
ALBUM_CAP = 4
PLAYLIST_CAP = 4


def search_music(query, limit, source="auto"):
    """Dispatch a search by explicit source, returning a typed-union list.

    auto/ytmusic -> songs (cap ~8) + albums (cap ~4) + playlists (cap ~4),
                    songs first. auto falls back to ytmusic videos then plain
                    yt-dlp ytsearch only when ytmusic yields no songs.
    youtube      -> only the yt-dlp ytsearch song path (all type:"song").
    """
    if source == "youtube":
        return _ytdlp_search(query, limit)

    song_cap = min(SONG_CAP, limit) if source == "ytmusic" else SONG_CAP
    songs = _ytmusic_songs(query, song_cap)
    if source != "ytmusic" and not songs:
        # auto fallback: try videos, then plain yt-dlp — songs only, no
        # albums/playlists on the degraded path.
        songs = _ytmusic_videos(query, song_cap)
        if not songs:
            return _ytdlp_search(query, limit)

    albums = _safe_section(_ytmusic_albums, query, ALBUM_CAP)
    playlists = _safe_section(_ytmusic_playlists, query, PLAYLIST_CAP)
    # Songs first, then albums, then playlists.
    return songs + albums + playlists


def _safe_section(fn, query, cap):
    """Albums/playlists are supplementary — a failure there must never sink the
    whole search, which is anchored by songs."""
    try:
        return fn(query, cap)
    except Exception:  # noqa: BLE001
        return []


def _ytdlp_search(query, limit):
    try:
        proc = subprocess.run(
            [
                "yt-dlp",
                f"ytsearch{limit}:{query}",
                "--flat-playlist",
                "--dump-single-json",
                "--no-warnings",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        data = json.loads(proc.stdout or "{}")
    except (subprocess.SubprocessError, ValueError):
        return []
    out = []
    for entry in data.get("entries", []) or []:
        vid = entry.get("id")
        if not vid:
            continue
        out.append(
            {
                "type": "song",
                "videoId": vid,
                "title": entry.get("title"),
                "artist": entry.get("uploader"),
                "artists": [entry.get("uploader")] if entry.get("uploader") else [],
                "album": None,
                "durationSeconds": entry.get("duration"),
                # --flat-playlist rarely carries a thumbnail; fall back to the
                # deterministic YouTube thumbnail URL so YouTube-source results
                # always have a preview image (every video has this URL).
                "thumbnailUrl": (
                    entry.get("thumbnail")
                    or _first_thumb(entry.get("thumbnails"))
                    or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                ),
                "source": "youtube",
            }
        )
    return out


# ---------------------------------------------------------------------------
# Already-downloaded detection + instant-play (stream without download)
# ---------------------------------------------------------------------------

def _library_video_index():
    """Map every downloaded videoId -> its Jellyfin itemId, read from the
    "[videoId].ext" tail target_path() writes on each file. Cached for
    LIB_INDEX_TTL so a burst of searches makes at most one Jellyfin call; on a
    Jellyfin hiccup we serve the last good map rather than dropping the flags."""
    now = time.monotonic()
    with _lib_lock:
        if _lib_index["map"] and now - _lib_index["ts"] < LIB_INDEX_TTL:
            return _lib_index["map"]
    mapping = {}
    try:
        data = (
            _jellyfin_request(
                "GET",
                "/Items?IncludeItemTypes=Audio&Recursive=true&Fields=Path&Limit=100000",
            )
            or {}
        )
        for it in data.get("Items", []) or []:
            m = _VIDEO_IN_PATH.search(it.get("Path") or "")
            item_id = it.get("Id")
            if m and item_id:
                mapping[m.group(1)] = item_id
    except (urllib.error.URLError, OSError, ValueError):
        with _lib_lock:
            return _lib_index["map"]
    with _lib_lock:
        _lib_index["map"] = mapping
        _lib_index["ts"] = now
    return mapping


def _resolve_item_id(video_id):
    """Fresh (uncached) videoId -> Jellyfin itemId lookup, used to complete a
    finished download job once its file has actually been scanned in."""
    if not video_id:
        return None
    try:
        data = (
            _jellyfin_request(
                "GET",
                "/Items?IncludeItemTypes=Audio&Recursive=true&Fields=Path&Limit=100000",
            )
            or {}
        )
    except (urllib.error.URLError, OSError, ValueError):
        return None
    for it in data.get("Items", []) or []:
        m = _VIDEO_IN_PATH.search(it.get("Path") or "")
        if m and m.group(1) == video_id and it.get("Id"):
            return it["Id"]
    return None


def _video_for_item(item_id):
    """Reverse of _library_video_index: the videoId a downloaded item came from,
    read off the "[videoId]" tail in its path. Lets a radio be seeded from a
    Jellyfin track (album / playlist / library), which knows no videoId itself.
    None for files that predate the naming scheme — the caller then falls back
    to the generic feed rather than failing."""
    if not item_id:
        return None
    for video_id, mapped in _library_video_index().items():
        if mapped == item_id:
            return video_id
    return None


def _annotate_downloaded(results):
    """Tag each song result with `downloaded` + `jellyfinItemId` (matched EXACTLY
    by videoId against the library) and float already-downloaded songs to the
    front, so "what I already have" reads first. Albums/playlists are untouched
    and keep their position after the songs."""
    if not results:
        return results
    index = _library_video_index()
    for r in results:
        if r.get("type") == "song":
            item_id = index.get(r.get("videoId")) if r.get("videoId") else None
            r["downloaded"] = bool(item_id)
            r["jellyfinItemId"] = item_id
    songs = [r for r in results if r.get("type") == "song"]
    rest = [r for r in results if r.get("type") != "song"]
    # Stable sort: downloaded songs first, original order preserved within each group.
    songs.sort(key=lambda r: 0 if r.get("downloaded") else 1)
    return songs + rest


_STREAM_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def _resolve_stream_url(video_id, source="auto", force=False):
    """Resolve a directly-playable googlevideo audio URL for a videoId via yt-dlp,
    cached (STREAM_URL_TTL). Prefers a progressive m4a (clean Content-Type +
    seekable), falling back to whatever bestaudio yt-dlp finds."""
    now = time.monotonic()
    if not force:
        with _stream_lock:
            cached = _stream_cache.get(video_id)
            if cached and cached[1] > now:
                return cached[0]
    watch = (
        f"https://music.youtube.com/watch?v={video_id}"
        if source == "ytmusic"
        else f"https://www.youtube.com/watch?v={video_id}"
    )
    try:
        proc = subprocess.run(
            [
                "yt-dlp",
                "-f",
                "bestaudio[ext=m4a]/bestaudio",
                "-g",
                "--no-playlist",
                "--no-warnings",
                watch,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.SubprocessError:
        return None
    lines = (proc.stdout or "").strip().splitlines()
    url = lines[0].strip() if lines else None
    if not url:
        return None
    with _stream_lock:
        _stream_cache[video_id] = (url, now + STREAM_URL_TTL)
    return url


def _open_stream_upstream(url, range_header):
    """Open the googlevideo URL from the worker's IP (the URL is IP-locked to
    whoever resolved it), forwarding the client's Range so seeking works."""
    headers = {"User-Agent": _STREAM_UA}
    if range_header:
        headers["Range"] = range_header
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=20)


# ---------------------------------------------------------------------------
# Download queue worker (concurrency 1)
# ---------------------------------------------------------------------------

def _retag(path, title, artist, album, genre=None):
    """Authoritatively rewrite m4a tags from the ytmusicapi metadata so
    Jellyfin groups Artist/Album/Track cleanly (yt-dlp's inferred tags on the
    YT Music path are unreliable). Genre, when known, surfaces as a Jellyfin
    MusicGenre for browse-by-genre."""
    try:
        from mutagen.mp4 import MP4

        audio = MP4(path)
        if title:
            audio["\xa9nam"] = [title]
        if artist:
            audio["\xa9ART"] = [artist]
            audio["aART"] = [artist]  # album artist -> stable Jellyfin grouping
        if album:
            audio["\xa9alb"] = [album]
        if genre:
            audio["\xa9gen"] = [genre]  # -> Jellyfin MusicGenre
        audio.save()
    except Exception:  # noqa: BLE001 — tagging is best-effort, never fail the job.
        pass


def _parse_length(text):
    """Parse an ytmusicapi "m:ss" / "h:mm:ss" duration into whole seconds."""
    if not text or not isinstance(text, str):
        return None
    parts = text.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    seconds = 0
    for n in nums:
        seconds = seconds * 60 + n
    return seconds


def _fetch_genre(video_id):
    """Best-effort genre lookup via ytmusicapi. Returns a genre string or None.

    ytmusicapi does not expose a genre on the song surface directly, so we walk
    the song -> album -> album-details path where a genre is occasionally
    present. Never invents a value; any failure or absence yields None."""
    if not video_id:
        return None
    try:
        yt = _get_ytmusic()
    except Exception:  # noqa: BLE001
        return None

    # 1) Album browseId reachable from the song's metadata, then album details.
    try:
        song = yt.get_song(video_id) or {}
        micro = song.get("microformat", {}) or {}
        # Some responses carry a plain category (e.g. "Music") — not a genre,
        # so it is deliberately ignored. We rely on album details below.
        _ = micro
    except Exception:  # noqa: BLE001
        song = {}

    browse_id = None
    try:
        # get_watch_playlist exposes the current track's album browseId cleanly.
        wp = yt.get_watch_playlist(videoId=video_id, limit=1) or {}
        for track in wp.get("tracks", []) or []:
            if track.get("videoId") == video_id:
                album = track.get("album") or {}
                if isinstance(album, dict):
                    browse_id = album.get("id")
                break
    except Exception:  # noqa: BLE001
        browse_id = None

    if not browse_id:
        return None
    try:
        album = yt.get_album(browse_id) or {}
    except Exception:  # noqa: BLE001
        return None
    genre = album.get("genre") or album.get("type")
    if isinstance(genre, str) and genre.strip() and genre.strip().lower() not in ("album", "single", "ep"):
        return genre.strip()
    return None


def _run_download(job):
    video_id = job["videoId"]
    artist = job.get("artist") or DEFAULT_ARTIST
    album = job.get("album") or DEFAULT_ALBUM
    title = job.get("title") or video_id

    out_path = target_path(artist, album, title, video_id)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Skip if the exact file already exists (idempotent re-runs).
    if os.path.exists(out_path):
        return out_path, None

    # Source picks the watch host: YT Music for clean audio streams, plain
    # YouTube for videos that only exist on the regular site.
    if job.get("source") == "ytmusic":
        watch_url = f"https://music.youtube.com/watch?v={video_id}"
    else:
        watch_url = f"https://www.youtube.com/watch?v={video_id}"

    # yt-dlp writes to `<base>.<ext>`; with --audio-format m4a the ext is m4a.
    template = out_path[: -len(".m4a")] + ".%(ext)s"
    cmd = [
        "yt-dlp",
        watch_url,
        "-x",
        "--audio-format",
        "m4a",
        "--audio-quality",
        "0",
        "--embed-metadata",
        "--embed-thumbnail",
        "--convert-thumbnail",
        "jpg",
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "-o",
        template,
    ]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT_S
    )
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()
        err = tail[-1] if tail else f"yt-dlp exit {proc.returncode}"
        return None, f"yt-dlp exit {proc.returncode}: {err}"[:500]

    if not os.path.exists(out_path):
        # Postprocessing may have produced a slightly different ext — recover it.
        base = out_path[: -len(".m4a")]
        for cand in (base + ".m4a", base + ".mp4", base + ".opus"):
            if os.path.exists(cand):
                if cand != out_path:
                    shutil.move(cand, out_path)
                break
        else:
            return None, "download reported success but no output file found"
    return out_path, None


def _worker_loop():
    while True:
        job_id = _download_queue.get()
        try:
            with _lock:
                job = _jobs.get(job_id)
            if not job:
                continue

            _set_state(job_id, "downloading")
            try:
                out_path, err = _run_download(job)
            except subprocess.TimeoutExpired:
                _set_state(job_id, "failed", error="download timed out (>5min)")
                continue
            except Exception as exc:  # noqa: BLE001
                _set_state(job_id, "failed", error=str(exc)[:500])
                continue

            if err:
                _set_state(job_id, "failed", error=err)
                continue

            # Best-effort genre tag so Jellyfin exposes browse-by-genre over
            # time. Only YT Music tracks carry usable album/genre metadata;
            # skip the lookup entirely for plain YouTube.
            genre = None
            if job.get("source") == "ytmusic":
                genre = _fetch_genre(job.get("videoId"))
            if genre:
                _set_state(job_id, "downloading", genre=genre)
            _retag(out_path, job.get("title"), job.get("artist"), job.get("album"), genre)

            with _lock:
                _downloaded.add(job["videoId"])
                _persist_manifest()

            _set_state(job_id, "scanning")
            _schedule_refresh()
            _set_state(job_id, "done")
        finally:
            with _lock:
                # Release the coalescing slot once terminal.
                if _active_by_video.get(job.get("videoId")) == job_id:
                    _active_by_video.pop(job.get("videoId"), None)
            _download_queue.task_done()


def enqueue_download(payload):
    video_id = payload.get("videoId")
    if not video_id or not isinstance(video_id, str):
        return None, "videoId required"

    # "Already have it" is decided by the actual library, not the on-disk manifest
    # (which lies when a file was deleted straight from Jellyfin). Cached, so a
    # batch of enqueues shares a single Jellyfin call.
    existing_item = _library_video_index().get(video_id)

    with _lock:
        if existing_item:
            # Synthesize a done job carrying the real itemId so the client settles.
            job = _new_job(payload, state="done")
            job["jellyfinItemId"] = existing_item
            return job, None
        # Coalesce an in-flight job for the same videoId.
        existing_id = _active_by_video.get(video_id)
        if existing_id and existing_id in _jobs:
            return _jobs[existing_id], None

        job = _new_job(payload, state="queued")
        _active_by_video[video_id] = job["id"]

    _download_queue.put(job["id"])
    return job, None


def _new_job(payload, state):
    # Called under _lock (or for a terminal synthetic job).
    job_id = uuid.uuid4().hex[:16]
    source = payload.get("source")
    if source not in ("ytmusic", "youtube"):
        source = "ytmusic"  # default: prefer clean YT Music audio streams
    job = {
        "id": job_id,
        "state": state,
        "videoId": payload.get("videoId"),
        "title": payload.get("title"),
        "artist": payload.get("artist"),
        "album": payload.get("album"),
        "source": source,
        "genre": None,
        "error": None,
        "jellyfinItemId": None,
        "createdAt": int(time.time()),
    }
    _jobs[job_id] = job
    _job_order.append(job_id)
    # Evict old jobs beyond the cap.
    while len(_job_order) > MAX_JOBS_KEPT * 2:
        old = _job_order.pop(0)
        _jobs.pop(old, None)
    _persist_jobs()
    return job


# ---------------------------------------------------------------------------
# Playlists: resolve a YouTube / YT Music playlist and fan out into jobs
# ---------------------------------------------------------------------------

_PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,}$")


def _normalize_playlist_url(url):
    """Accept a full playlist URL or a bare playlist id. Returns a URL or None."""
    url = (url or "").strip()
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if _PLAYLIST_ID_RE.match(url):
        return f"https://music.youtube.com/playlist?list={url}"
    return None


def resolve_playlist(url):
    """Resolve a playlist URL/id into a list of track payloads via yt-dlp's
    flat-playlist dump (works for both youtube.com and music.youtube.com).
    Returns a list of payloads, or None on a resolution failure."""
    norm = _normalize_playlist_url(url)
    if not norm:
        return None
    source = "ytmusic" if "music.youtube.com" in norm else "youtube"
    try:
        proc = subprocess.run(
            [
                "yt-dlp",
                norm,
                "--flat-playlist",
                "--dump-single-json",
                "--no-warnings",
            ],
            capture_output=True,
            text=True,
            timeout=90,
        )
        data = json.loads(proc.stdout or "{}")
    except (subprocess.SubprocessError, ValueError):
        return None
    tracks = []
    for entry in data.get("entries", []) or []:
        vid = entry.get("id")
        if not vid:
            continue
        uploader = entry.get("uploader") or entry.get("channel")
        tracks.append(
            {
                "videoId": vid,
                "title": entry.get("title"),
                "artist": uploader,
                "album": None,
                "source": source,
            }
        )
    return tracks


def _ytmusic_track_payload(track, album_name=None):
    """Map an ytmusicapi playlist/album track into a download payload."""
    artists = [a.get("name") for a in (track.get("artists") or []) if a.get("name")]
    album = track.get("album")
    if isinstance(album, dict):
        album = album.get("name")
    return {
        "videoId": track.get("videoId"),
        "title": track.get("title"),
        "artist": artists[0] if artists else None,
        "album": album or album_name,
        "source": "ytmusic",
    }


def resolve_ytmusic_playlist(playlist_id):
    """Resolve a YT Music playlist id into track payloads via ytmusicapi.
    Returns a list of payloads, or None on failure."""
    playlist_id = (playlist_id or "").strip()
    if not playlist_id:
        return None
    if playlist_id.startswith("VL"):
        playlist_id = playlist_id[2:]
    try:
        data = _get_ytmusic().get_playlist(playlist_id, limit=None) or {}
    except Exception:  # noqa: BLE001
        return None
    tracks = []
    for track in data.get("tracks", []) or []:
        if track.get("videoId"):
            tracks.append(_ytmusic_track_payload(track))
    return tracks


def resolve_album(browse_id):
    """Resolve an album browseId into track payloads via ytmusicapi.
    Returns a list of payloads, or None on failure."""
    browse_id = (browse_id or "").strip()
    if not browse_id:
        return None
    try:
        data = _get_ytmusic().get_album(browse_id) or {}
    except Exception:  # noqa: BLE001
        return None
    album_name = data.get("title")
    tracks = []
    for track in data.get("tracks", []) or []:
        if track.get("videoId"):
            tracks.append(_ytmusic_track_payload(track, album_name=album_name))
    return tracks


def _fan_out_tracks(tracks, resolve_err, empty_err):
    """Enqueue each track as a normal download job (dedup + concurrency 1
    preserved) and record a batch. Returns (result, err)."""
    if tracks is None:
        return None, resolve_err
    if not tracks:
        return None, empty_err

    job_ids = []
    for track in tracks:
        job, err = enqueue_download(track)
        if err or not job:
            continue
        job_ids.append(job["id"])

    batch_id = uuid.uuid4().hex[:16]
    with _lock:
        _batches[batch_id] = {"jobIds": job_ids, "createdAt": int(time.time())}
        _batch_order.append(batch_id)
        while len(_batch_order) > MAX_BATCHES_KEPT * 2:
            old = _batch_order.pop(0)
            _batches.pop(old, None)
        _persist_batches()
    return {"batchId": batch_id, "count": len(job_ids), "jobIds": job_ids}, None


def enqueue_playlist(url):
    """Resolve a playlist URL/id via yt-dlp and fan out into download jobs."""
    return _fan_out_tracks(
        resolve_playlist(url), "playlist_resolve_failed", "playlist_empty"
    )


def enqueue_ytmusic_playlist(playlist_id):
    """Resolve a YT Music playlistId via ytmusicapi and fan out into jobs."""
    return _fan_out_tracks(
        resolve_ytmusic_playlist(playlist_id), "playlist_resolve_failed", "playlist_empty"
    )


def enqueue_album(browse_id):
    """Resolve an album browseId via ytmusicapi and fan out into jobs."""
    return _fan_out_tracks(
        resolve_album(browse_id), "album_resolve_failed", "album_empty"
    )


def batch_status(batch_id):
    """Aggregate the live state of a playlist batch, or None if unknown."""
    with _lock:
        batch = _batches.get(batch_id)
        if not batch:
            return None
        job_ids = list(batch.get("jobIds", []))
        jobs = []
        done = failed = 0
        for jid in job_ids:
            job = _jobs.get(jid)
            state = job["state"] if job else "unknown"
            video_id = job.get("videoId") if job else None
            if state == "done":
                done += 1
            elif state == "failed":
                failed += 1
            jobs.append({"jobId": jid, "videoId": video_id, "state": state})
    return {
        "batchId": batch_id,
        "total": len(job_ids),
        "done": done,
        "failed": failed,
        "jobs": jobs,
    }


# ---------------------------------------------------------------------------
# Recommendations (ytmusicapi, best-effort — never 500)
# ---------------------------------------------------------------------------

def _map_watch_track(track):
    artists = [a.get("name") for a in (track.get("artists") or []) if a.get("name")]
    album = track.get("album") or {}
    album_name = album.get("name") if isinstance(album, dict) else None
    return {
        "type": "song",
        "videoId": track.get("videoId"),
        "title": track.get("title"),
        "artist": artists[0] if artists else None,
        "artists": artists,
        "album": album_name,
        "durationSeconds": _parse_length(track.get("length")),
        # Watch-playlist tracks carry the list under `thumbnail`, home items
        # under `thumbnails` — _item_thumbs resolves either so recs are never
        # left with a null thumbnailUrl when the source provides one.
        "thumbnailUrl": _first_thumb(_item_thumbs(track)),
        "source": "ytmusic",
    }


def collection_tracks(browse_id=None, playlist_id=None, limit=200):
    """Track list for an album or a playlist, WITHOUT downloading anything.

    Collections were download-only until now: the SPA knew an album by its
    browseId and a playlist by its playlistId, neither of which can be streamed
    -- only the individual videoIds inside them can. Handing back that list is
    what lets a collection be played or queued straight from search, through the
    same /stream proxy a single search hit already uses.

    Best-effort, like the rest of the ytmusicapi surface: an empty list means the
    caller falls back to offering the download it always had.
    """
    try:
        yt = _get_ytmusic()
    except Exception:  # noqa: BLE001
        return []

    try:
        if browse_id:
            data = yt.get_album(browse_id) or {}
        else:
            pid = (playlist_id or "").strip()
            # Search returns playlist ids both bare and "VL"-prefixed.
            if pid.startswith("VL"):
                pid = pid[2:]
            if not pid:
                return []
            data = yt.get_playlist(pid, limit=limit) or {}
    except Exception:  # noqa: BLE001
        return []

    # Album tracks inherit the cover art instead of carrying their own, so the
    # collection art is the fallback rather than leaving every row blank.
    fallback_thumb = _first_thumb(_item_thumbs(data))
    results = []
    for track in (data.get("tracks") or []):
        if not track.get("videoId"):
            continue
        mapped = _map_watch_track(track)
        if not mapped.get("thumbnailUrl"):
            mapped["thumbnailUrl"] = fallback_thumb
        results.append(mapped)
    return results[:limit]


def _recent_seed_video():
    """Most recent completed download's videoId, used as an implicit rec seed."""
    with _lock:
        for jid in reversed(_job_order):
            job = _jobs.get(jid)
            if job and job.get("state") == "done" and job.get("videoId"):
                return job["videoId"]
    return None


def _home_recommendations(yt, limit):
    out = []
    seen = set()
    home = yt.get_home(limit=3) or []
    for section in home:
        for item in section.get("contents", []) or []:
            vid = item.get("videoId")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            out.append(_map_song(item))
            if len(out) >= limit:
                return out
    return out


def recommendations(seed, limit):
    """Related tracks for a seed videoId (get_watch_playlist), or home quick
    picks when no seed is available. Best-effort: returns [] on any failure."""
    try:
        yt = _get_ytmusic()
    except Exception:  # noqa: BLE001
        return []

    if not seed:
        seed = _recent_seed_video()

    try:
        if seed:
            wp = yt.get_watch_playlist(videoId=seed, limit=limit + 5) or {}
            results = [
                _map_watch_track(t)
                for t in (wp.get("tracks") or [])
                if t.get("videoId") and t.get("videoId") != seed
            ]
        else:
            results = _home_recommendations(yt, limit)
    except Exception:  # noqa: BLE001
        return []
    return results[:limit]


# ---------------------------------------------------------------------------
# Jellyfin: ensure the music library + debounced scans
# ---------------------------------------------------------------------------

def _jellyfin_request(method, path, body=None):
    url = f"{JELLYFIN_URL}{path}"
    headers = {"X-Emby-Token": JELLYFIN_API_KEY, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        if not raw:
            return None
        return json.loads(raw)


def _schedule_refresh():
    global _refresh_timer
    with _lock:
        if _refresh_timer is not None:
            _refresh_timer.cancel()
        _refresh_timer = threading.Timer(REFRESH_DEBOUNCE_S, _trigger_refresh)
        _refresh_timer.daemon = True
        _refresh_timer.start()


def _trigger_refresh():
    try:
        _jellyfin_request("POST", "/Library/Refresh")
    except (urllib.error.URLError, OSError, ValueError):
        pass


def ensure_music_library():
    """Idempotently make sure a `music` collection pointing at MUSIC_DIR
    exists in Jellyfin. Best-effort — a transient Jellyfin outage at startup
    must not crash the worker."""
    if not JELLYFIN_API_KEY:
        return
    try:
        folders = _jellyfin_request("GET", "/Library/VirtualFolders") or []
    except (urllib.error.URLError, OSError, ValueError):
        return
    for folder in folders:
        if (folder.get("CollectionType") or "").lower() == "music":
            return  # already present
    try:
        params = urllib.parse.urlencode(
            {"name": "Música", "collectionType": "music", "refreshLibrary": "false"}
        )
        _jellyfin_request(
            "POST",
            f"/Library/VirtualFolders?{params}",
            body={"LibraryOptions": {"PathInfos": [{"Path": MUSIC_DIR}]}},
        )
    except (urllib.error.URLError, OSError, ValueError):
        pass


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def _public_job(job):
    return {
        "id": job["id"],
        "state": job["state"],
        "error": job.get("error"),
        "videoId": job.get("videoId"),
        "jellyfinItemId": job.get("jellyfinItemId"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _user_id(self):
        """Who is asking, per the BFF's X-PF-User header. The worker sits on the
        internal network behind the BFF, which is the only thing that can
        authenticate a session; an absent header means an anonymous read."""
        return (self.headers.get("X-PF-User") or "").strip() or None

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _stream(self, qs):
        """Instant-play: resolve the videoId's audio URL and range-proxy the
        bytes so the browser plays it WITHOUT a prior download. Seeking works
        because the client's Range header is forwarded to googlevideo."""
        video_id = (qs.get("videoId", [""])[0]).strip()
        if not video_id:
            return self._send(400, {"error": "videoId required"})
        source = (qs.get("source", ["auto"])[0]).strip().lower()
        if source not in ("auto", "ytmusic", "youtube"):
            source = "auto"
        range_header = self.headers.get("Range")

        # Resolve (cached) then proxy. A stale/expired URL comes back 403/410 from
        # googlevideo — force a fresh resolve once before giving up.
        upstream = None
        for attempt in range(2):
            url = _resolve_stream_url(video_id, source, force=(attempt == 1))
            if not url:
                return self._send(502, {"error": "resolve_failed"})
            try:
                upstream = _open_stream_upstream(url, range_header)
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (403, 410) and attempt == 0:
                    continue  # expired signed URL — re-resolve and retry
                return self._send(502, {"error": "upstream_error", "code": exc.code})
            except (urllib.error.URLError, OSError):
                return self._send(502, {"error": "upstream_unreachable"})
        if upstream is None:
            return self._send(502, {"error": "resolve_failed"})

        try:
            self.send_response(getattr(upstream, "status", 200) or 200)
            for header in ("Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"):
                value = upstream.headers.get(header)
                if value:
                    self.send_header(header, value)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client seeked or closed the tab — normal for audio playback
        finally:
            try:
                upstream.close()
            except Exception:  # noqa: BLE001
                pass

    def log_message(self, *args):  # quieter default logging
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/healthz":
            return self._send(200, {"ok": True})

        if path == "/stream":
            qs = urllib.parse.parse_qs(parsed.query)
            return self._stream(qs)

        if path == "/search":
            qs = urllib.parse.parse_qs(parsed.query)
            query = (qs.get("q", [""])[0]).strip()
            if not query:
                return self._send(400, {"error": "q required"})
            try:
                limit = int(qs.get("limit", ["10"])[0])
            except ValueError:
                limit = 10
            limit = max(1, min(limit, 25))
            source = (qs.get("source", ["auto"])[0]).strip().lower()
            if source not in ("auto", "ytmusic", "youtube"):
                source = "auto"
            try:
                results = search_music(query, limit, source)
            except Exception as exc:  # noqa: BLE001
                return self._send(502, {"error": "search_failed", "message": str(exc)[:200]})
            # Search is NOT filtered: the user asked for this by name, and hiding
            # a result they typed would read as a broken search. Only annotated,
            # so the row can render the vote it already carries.
            return self._send(
                200,
                {"results": _annotate_ratings(_annotate_downloaded(results), self._user_id())},
            )

        if path == "/ratings":
            return self._send(200, {"ratings": user_ratings(self._user_id())})

        if path == "/recommendations":
            qs = urllib.parse.parse_qs(parsed.query)
            seed = (qs.get("seed", [""])[0]).strip() or None
            # `itemId` seeds a radio from a library track: resolve it to the
            # videoId it was downloaded from, then take the normal seeded path.
            if not seed:
                seed = _video_for_item((qs.get("itemId", [""])[0]).strip() or None)
            try:
                limit = int(qs.get("limit", ["10"])[0])
            except ValueError:
                limit = 10
            limit = max(1, min(limit, 25))
            try:
                results = recommendations(seed, limit)
            except Exception:  # noqa: BLE001 — recommendations are best-effort.
                results = []
            # A radio that keeps serving what you rejected is the whole reason
            # the thumb-down exists, so this filter runs before anything else.
            user_id = self._user_id()
            results = _drop_disliked(results, user_id)
            return self._send(
                200, {"results": _annotate_ratings(_annotate_downloaded(results), user_id)}
            )

        if path == "/collection":
            qs = urllib.parse.parse_qs(parsed.query)
            browse_id = (qs.get("browseId", [""])[0]).strip() or None
            playlist_id = (qs.get("playlistId", [""])[0]).strip() or None
            if not browse_id and not playlist_id:
                return self._send(400, {"error": "missing_collection_id"})
            try:
                limit = int(qs.get("limit", ["200"])[0])
            except ValueError:
                limit = 200
            limit = max(1, min(limit, 500))
            try:
                results = collection_tracks(browse_id, playlist_id, limit)
            except Exception:  # noqa: BLE001 — best-effort, same as search.
                results = []
            user_id = self._user_id()
            results = _drop_disliked(results, user_id)
            return self._send(
                200, {"results": _annotate_ratings(_annotate_downloaded(results), user_id)}
            )

        if path == "/downloads":
            with _lock:
                jobs = [_public_job(_jobs[j]) for j in _job_order[-MAX_JOBS_KEPT:] if j in _jobs]
            jobs.reverse()  # newest first
            return self._send(200, {"jobs": jobs})

        m = re.match(r"^/downloads/([^/]+)$", path)
        if m:
            with _lock:
                job = _jobs.get(m.group(1))
            if not job:
                return self._send(404, {"error": "not_found"})
            # A finished job carries no itemId until Jellyfin has scanned the new
            # file in (the scan is async/debounced). Resolve it lazily so a caller
            # polling a "done" job eventually gets a real jellyfinItemId.
            if job.get("state") == "done" and not job.get("jellyfinItemId"):
                resolved = _resolve_item_id(job.get("videoId"))
                if resolved:
                    with _lock:
                        job["jellyfinItemId"] = resolved
                        _persist_jobs()
            return self._send(200, _public_job(job))

        m = re.match(r"^/playlists/([^/]+)$", path)
        if m:
            status = batch_status(m.group(1))
            if status is None:
                return self._send(404, {"error": "not_found"})
            return self._send(200, status)

        return self._send(404, {"error": "not_found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/downloads", "/playlists", "/ratings"):
            return self._send(404, {"error": "not_found"})

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            return self._send(400, {"error": "invalid_json"})

        if parsed.path == "/ratings":
            video_id = (payload.get("videoId") or "").strip()
            if not video_id:
                return self._send(400, {"error": "missing_video_id"})
            try:
                rating = int(payload.get("rating", 0))
            except (TypeError, ValueError):
                rating = 0
            if rating not in (1, -1, 0):
                return self._send(400, {"error": "invalid_rating"})
            stored = set_rating(self._user_id(), video_id, rating)
            return self._send(200, {"videoId": video_id, "rating": stored})

        if parsed.path == "/playlists":
            playlist_id = payload.get("playlistId")
            browse_id = payload.get("browseId")
            url = payload.get("url")
            if playlist_id and isinstance(playlist_id, str):
                result, err = enqueue_ytmusic_playlist(playlist_id)
            elif browse_id and isinstance(browse_id, str):
                result, err = enqueue_album(browse_id)
            elif url and isinstance(url, str):
                result, err = enqueue_playlist(url)
            else:
                return self._send(400, {"error": "playlistId, browseId, or url required"})
            if err:
                return self._send(400, {"error": err})
            return self._send(202, result)

        job, err = enqueue_download(payload)
        if err:
            return self._send(400, {"error": err})
        return self._send(201, {"jobId": job["id"], "state": job["state"]})


def main():
    _load_state()
    os.makedirs(MUSIC_DIR, exist_ok=True)

    worker = threading.Thread(target=_worker_loop, daemon=True)
    worker.start()

    # Ensure the Jellyfin music library exists (best-effort, off the hot path).
    threading.Thread(target=ensure_music_library, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"poisonflix-music-worker listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
