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

import concurrent.futures
import http.client
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
PLAYS_PATH = os.path.join(DATA_DIR, "plays.json")

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
# 1h. Scoped to S1 (slow-start / repeat-play latency) ONLY: googlevideo URLs
# live hours (see the yt-dlp call in _resolve_stream_url below), and at the old
# 5 min TTL the second
# play of any 3-4 min track missed the cache and paid the ~2.1-2.3s yt-dlp
# resolve again. Explicitly NOT a fix for the 2x-duration
# defect — that theory (a stale/spliced URL) was refuted by a controlled
# experiment serving the worker's exact bytes to headless Chromium, which
# reported the correct duration both with and without Range support. That
# defect is no longer unidentified: it is the DASH fragmentation itself, and
# the progressive remux cache further down is what fixes it. Not
# raised further than this: _stream_cache is an unbounded dict with no
# eviction, and a longer TTL widens the staleness window a re-resolve has to
# cover; that staleness is already absorbed by the force=True re-resolve path
# on a 403/410 upstream failure (see _resolve_stream_url's retry loop below).
STREAM_URL_TTL = 3600.0

# videoId -> Jellyfin itemId, derived from the "[videoId].ext" tail every
# downloaded file carries (see target_path). Cached briefly so a burst of
# searches makes at most one Jellyfin call.
_lib_lock = threading.Lock()
_lib_index = {"map": {}, "ts": 0.0}
LIB_INDEX_TTL = 30.0
_VIDEO_IN_PATH = re.compile(r"\[([A-Za-z0-9_-]{6,})\]\.[A-Za-z0-9]+$")


# --- iOS fMP4 duration patch (SUPERSEDED — fallback path only) --------------
# HISTORY, kept because the fallback proxy still calls this and a maintainer
# needs to know it does NOT fix what its name suggests.
#
# YouTube only serves DASH-fragmented audio (every format is `*_dash`), and those
# files carry the total duration TWICE: once in `moov/mvhd` and again in the
# fragment timeline. iOS WebKit ADDS them, so a 3:14 track reports as 6:26 — the
# audio ends on time while the timer runs on through phantom silence.
#
# Renaming the redundant box to `free` looked like the surgical repair: `free` is
# padding every demuxer skips, the box KEEPS ITS LENGTH, so no byte offset moves
# and Range requests stay valid. It was shipped twice, for `sidx` and then for
# `edts`, and the DEVICE refuted both — with neither box in the delivered bytes
# an iPhone still reported exactly 2x (322.926s for a 162s track).
#
# The real fix is to stop serving a fragmented file at all: see the progressive
# remux cache below. This patch survives only on the fallback path, where it is
# free and harmless but is not what makes the duration right.
_SIDX_SCAN_LIMIT = 1 << 20  # both boxes sit right after moov; never megabytes in.

# Boxes that redundantly restate the total duration. The device log settled which
# one mattered: with `sidx` already stripped, an iPhone (iOS 18.7 / Safari 26.5)
# still reported 386.34s for a 193.18s track, so the sum was not coming from the
# segment index. `mvhd`, `mdhd` AND the edit list all declare the full length, and
# WebKit adds `mvhd` to the `elst` segment_duration:
#
#     mvhd 161.469s + elst 161.469s = 322.938s   (Mi Comedia, ~161s of dead air)
#
# `edts` is dropped whole rather than editing `elst` inside it. Its only other
# payload is media_time=1600 — 1600 samples of AAC encoder priming at 44100Hz,
# about 36ms — so losing it costs an inaudible sliver at the very start of a
# track, against two minutes of silence at the end.
_REDUNDANT_DURATION_BOXES = (b"sidx", b"edts")


def _neutralize_sidx(chunk, stream_offset):
    """Rewrite redundant duration boxes to `free` within this chunk.

    `stream_offset` is where the chunk starts in the response body. A box header
    straddling a chunk boundary is deliberately left alone: chunks are 64 KiB and
    sidx lands within the first few KiB, so the split case does not arise in
    practice and half-patching a header would corrupt the stream.
    """
    if stream_offset > _SIDX_SCAN_LIMIT:
        return chunk
    patched = None
    for tag in _REDUNDANT_DURATION_BOXES:
        idx = (patched or chunk).find(tag)
        while idx >= 4:  # need room for the preceding 4-byte size field
            if patched is None:
                patched = bytearray(chunk)
            patched[idx:idx + 4] = b"free"
            idx = patched.find(tag, idx + 4)
    return bytes(patched) if patched is not None else chunk

def _load_state():
    os.makedirs(DATA_DIR, exist_ok=True)
    _load_ratings()
    _load_plays()
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
# Shape: {userId: {videoId: {"v": 1|-1, "title", "artist", "thumb"}}}. A cleared
# vote drops the key rather than storing 0, so the file stays a record of
# opinions actually held.
#
# The metadata sits beside the vote for the same reason the play tally carries
# it: a videoId alone renders as nothing, and re-resolving one would mean a
# YouTube round trip per row. Without it "Tus me gusta" could only have listed
# bare ids. The client already holds the title and artist at the moment the
# thumb is pressed, so it sends them and this stores them.
#
# The older shape was {userId: {videoId: 1|-1}} — a bare int. _load_ratings
# still accepts it, so existing votes survive the upgrade; they simply have no
# title until the track is voted on again.
# ---------------------------------------------------------------------------

_ratings = {}
_ratings_lock = threading.Lock()


def _clean_vote(raw):
    """Normalise one stored vote, accepting both the old int and the new dict."""
    if isinstance(raw, dict):
        try:
            vote = int(raw.get("v"))
        except (TypeError, ValueError):
            return None
        if vote not in (1, -1):
            return None
        row = {"v": vote}
        for key in ("title", "artist", "thumb"):
            value = raw.get(key)
            if isinstance(value, str) and value:
                row[key] = value
        try:
            row["at"] = float(raw.get("at") or 0)
        except (TypeError, ValueError):
            row["at"] = 0
        return row
    try:
        vote = int(raw)
    except (TypeError, ValueError):
        return None
    return {"v": vote} if vote in (1, -1) else None


def _load_ratings():
    global _ratings
    try:
        with open(RATINGS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            clean = {}
            for uid, votes in data.items():
                if not isinstance(votes, dict):
                    continue
                bucket = {}
                for vid, raw in votes.items():
                    row = _clean_vote(raw)
                    if row:
                        bucket[str(vid)] = row
                if bucket:
                    clean[str(uid)] = bucket
            _ratings = clean
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
    """This user's votes as {videoId: 1|-1}.

    Deliberately still returns bare ints: every caller wants the opinion, not the
    track, and flattening here keeps _drop_disliked and _annotate_ratings exactly
    as they were. Use user_liked() when you need something renderable.
    """
    if not user_id:
        return {}
    with _ratings_lock:
        return {vid: row["v"] for vid, row in _ratings.get(user_id, {}).items()}


def user_liked(user_id):
    """The thumbed-up tracks, newest first, with enough metadata to render.

    This is the reader the thumb-up never had. Until it existed the only code
    that looked at the vote table was _drop_disliked, which tests for -1 — so a
    thumb-up changed nothing anywhere, and there was no screen to see one on.
    """
    if not user_id:
        return []
    with _ratings_lock:
        rows = dict(_ratings.get(user_id, {}))
    out = []
    for vid, row in rows.items():
        if row.get("v") != 1:
            continue
        out.append({
            "type": "song",
            "videoId": vid,
            "title": row.get("title") or vid,
            "artist": row.get("artist"),
            "artists": [row["artist"]] if row.get("artist") else [],
            "album": None,
            "durationSeconds": None,
            "thumbnailUrl": row.get("thumb"),
            "source": "ytmusic",
            "at": row.get("at") or 0,
        })
    out.sort(key=lambda r: r.get("at") or 0, reverse=True)
    return out


def set_rating(user_id, video_id, rating, title=None, artist=None, thumb=None):
    """rating: 1 (up), -1 (down), or 0 to clear. Returns the stored value.

    Metadata is optional and only ever added, never blanked: a later vote that
    arrives without a title must not erase one an earlier vote supplied.
    """
    if not user_id or not video_id:
        return 0
    with _ratings_lock:
        votes = _ratings.setdefault(user_id, {})
        if rating in (1, -1):
            row = votes.get(video_id) or {}
            row["v"] = rating
            row["at"] = time.time()
            for key, value in (("title", title), ("artist", artist), ("thumb", thumb)):
                if isinstance(value, str) and value:
                    row[key] = value
            votes[video_id] = row
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


# ---------------------------------------------------------------------------
# Preview play tally.
#
# Jellyfin owns listening history for anything IN the library, and that is the
# right owner: per user, persisted, backed up. But a preview -- a radio pick or
# a search hit streamed straight from YouTube -- has no Jellyfin item, so there
# is nothing there to bump. Since autoplay radio landed, that is most of what
# actually gets played, which left "Tu musica en numeros" reporting a number
# that was true and yet nothing like the user's listening.
#
# So previews are tallied HERE, keyed by videoId, exactly like ratings. Title,
# artist and length are stored alongside the count because the videoId alone
# says nothing renderable, and re-resolving it later would mean a YouTube round
# trip per row.
#
# Shape: {userId: {videoId: {count, title, artist, seconds, last}}}
# ---------------------------------------------------------------------------

_plays = {}
_plays_lock = threading.Lock()


def _load_plays():
    global _plays
    try:
        with open(PLAYS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            clean = {}
            for uid, rows in data.items():
                if not isinstance(rows, dict):
                    continue
                bucket = {}
                for vid, row in rows.items():
                    if not isinstance(row, dict):
                        continue
                    try:
                        count = int(row.get("count", 0))
                    except (TypeError, ValueError):
                        continue
                    if count <= 0:
                        continue
                    bucket[str(vid)] = {
                        "count": count,
                        "title": str(row.get("title") or ""),
                        "artist": str(row.get("artist") or ""),
                        "seconds": int(row.get("seconds") or 0),
                        "last": float(row.get("last") or 0),
                    }
                if bucket:
                    clean[str(uid)] = bucket
            _plays = clean
    except (FileNotFoundError, ValueError, AttributeError, TypeError):
        _plays = {}


def _persist_plays():
    # Called under _plays_lock. Best-effort, mirrors _persist_ratings.
    try:
        tmp = PLAYS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_plays, fh)
        os.replace(tmp, PLAYS_PATH)
    except OSError:
        pass


def user_plays(user_id):
    """This user's preview tally as a list of rows. Anonymous callers get an
    empty view rather than sharing a global bucket -- same rule as ratings."""
    if not user_id:
        return []
    with _plays_lock:
        rows = dict(_plays.get(user_id, {}))
    out = []
    for vid, row in rows.items():
        item = dict(row)
        item["videoId"] = vid
        out.append(item)
    out.sort(key=lambda r: r.get("count", 0), reverse=True)
    return out


def record_play(user_id, video_id, title, artist, seconds):
    """Counts one completed preview listen. Metadata is refreshed on every call
    so a row recorded before the title was known still fills in later."""
    if not user_id or not video_id:
        return 0
    with _plays_lock:
        bucket = _plays.setdefault(user_id, {})
        row = bucket.get(video_id) or {"count": 0, "title": "", "artist": "", "seconds": 0}
        row["count"] = int(row.get("count", 0)) + 1
        if title:
            row["title"] = title
        if artist:
            row["artist"] = artist
        if seconds:
            row["seconds"] = int(seconds)
        # `time` is already imported; an epoch float keeps the row JSON-plain
        # and avoids pulling in datetime just for a timestamp nothing parses.
        row["last"] = time.time()
        bucket[video_id] = row
        _persist_plays()
        return row["count"]


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


# --- Progressive remux cache ------------------------------------------------
# THE fix for "a 3 minute track plays for 5, the last 2 silent".
#
# YouTube serves audio only as DASH-fragmented MP4. Such a file states its total
# length in `moov` AND again in the fragment timeline, and iOS WebKit adds the
# two together. Two surgical attempts at deleting the redundant statement — the
# segment index (`sidx`), then the edit list (`edts`) — were each shipped and
# each refuted by the device itself, which kept reporting EXACTLY twice the real
# length afterwards:
#
#     22:34:46  elementDuration 322.926  trackDuration 162   (both boxes gone)
#     22:35:06  elementDuration 552.628  trackDuration 277   (both boxes gone)
#
# Those bytes carry no sidx and no edts — verified on the delivered response —
# so the remaining source of the second copy is the fragment timeline itself,
# which cannot be deleted from a fragmented file: it IS the file.
#
# So stop repairing a fragmented file and stop serving one. ffmpeg remuxes the
# same AAC bytes into a plain progressive MP4 — `-c copy`, no re-encode, ~90ms
# for a 2.6 MB track — which has no fragments, no sidx and one single duration
# for any demuxer to find. This is what every music service on the planet hands
# an iPhone, and it removes the whole class of defect rather than one instance
# of it.
#
# The price is that the first play of a track must fetch the whole file before
# the first byte goes out — about a second for a typical track, once the fetch
# sidesteps googlevideo's throttle (see _download_chunked). The remuxed result
# is cached on disk, so every later play —
# and every Range request, which is where seeking lives — is served locally from
# a file whose length is known, which is strictly faster and more correct than
# re-proxying googlevideo.
STREAM_CACHE_DIR = os.path.join(DATA_DIR, "streamcache")
STREAM_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024  # LRU-pruned by mtime
STREAM_FETCH_MAX_BYTES = 200 * 1024 * 1024  # refuse to buffer an absurd upstream
REMUX_TIMEOUT_S = 120
# A videoId reaches the filesystem as a path component, so it is constrained to
# the alphabet YouTube actually uses. Without this a crafted id is a traversal.
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{5,32}$")

_remux_guard = threading.Lock()
_remux_locks = {}  # videoId -> lock, so a burst of plays builds the cache once


def _remux_lock_for(video_id):
    with _remux_guard:
        if len(_remux_locks) > 500:
            # Cheap bound: drop the ones nobody is holding. A lock recreated
            # while a build runs would only cost a duplicate build, never
            # corruption — the build itself lands with os.replace.
            for key, lock in list(_remux_locks.items()):
                if not lock.locked():
                    del _remux_locks[key]
        return _remux_locks.setdefault(video_id, threading.Lock())


def _stream_cache_path(video_id):
    return os.path.join(STREAM_CACHE_DIR, f"{video_id}.m4a")


def _prune_stream_cache():
    """Keep the cache under STREAM_CACHE_MAX_BYTES, oldest-touched first."""
    try:
        entries = []
        for name in os.listdir(STREAM_CACHE_DIR):
            if not name.endswith(".m4a"):
                # A concurrent build's working files live in this same
                # directory as `<id>.m4a.raw.<hex>` / `<id>.m4a.out.<hex>`.
                # Pruning by mtime alone would unlink one while ffmpeg still
                # has to open it BY PATH, failing an unrelated request for a
                # reason that has nothing to do with its own upstream.
                continue
            path = os.path.join(STREAM_CACHE_DIR, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            entries.append((stat.st_mtime, stat.st_size, path))
    except OSError:
        return
    total = sum(size for _, size, _ in entries)
    if total <= STREAM_CACHE_MAX_BYTES:
        return
    for _, size, path in sorted(entries):
        try:
            os.remove(path)
        except OSError:
            continue
        total -= size
        if total <= STREAM_CACHE_MAX_BYTES:
            return


# googlevideo THROTTLES an open-ended GET to roughly playback speed, and that is
# what made "download the whole track first" look impossible. Measured on the
# worker against one 4.5 MB track:
#
#     open-ended GET      117.9s   (38 KB/s)
#     1 MiB Range chunk     0.67s  (1.6 MB/s)
#     4 x 1 MiB, serial     2.4s
#
# Same URL, same host, same second. The throttle is applied to the long-lived
# connection, not to the file — so the fetch is issued as bounded Range chunks,
# four at a time, and a normal track lands in about a second.
_CHUNK_BYTES = 1 << 20
_CHUNK_PARALLEL = 4
_CONTENT_RANGE_TOTAL = re.compile(r"/(\d+)\s*$")
# ONE pool for the whole process, not one per request. ThreadingHTTPServer has
# no connection cap, so a per-request executor would let N concurrent cold plays
# open 4N sockets to googlevideo with no backpressure. A shared bounded pool
# makes the surplus queue instead — the download queue next door is serialized
# to 1 for the same reason.
_CHUNK_POOL_WORKERS = 8
_chunk_pool = concurrent.futures.ThreadPoolExecutor(
    max_workers=_CHUNK_POOL_WORKERS, thread_name_prefix="chunkfetch"
)


def _range_get(url, start, end, cap=None):
    """One bounded Range read. Returns (body, total).

    `total` is tri-state, and callers must handle all three:
      int  — the resource's full size, parsed from Content-Range.
      None — the upstream sent a 206 with no parseable Content-Range.
      -1   — the upstream IGNORED Range and answered 200, so `body` already
             holds the whole file and there is nothing left to fetch.

    `cap` bounds the bytes actually buffered. It matters on that same -1 branch:
    without a cap that read is unbounded no matter how small a range was asked
    for.
    """
    limit = cap if cap is not None else (end - start + 1)
    headers = {"User-Agent": _STREAM_UA, "Range": f"bytes={start}-{end}"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = bytearray()
        while len(body) <= limit:
            piece = resp.read(65536)
            if not piece:
                break
            body.extend(piece)
        if len(body) > limit:
            raise ValueError("upstream body exceeds the fetch cap")
        match = _CONTENT_RANGE_TOTAL.search(resp.headers.get("Content-Range") or "")
        total = int(match.group(1)) if match else None
        if resp.status == 200:
            total = -1  # Range ignored: this body IS the whole file
        return bytes(body), total


def _fetch_upstream_to(video_id, source, dest):
    """Download the complete upstream audio to `dest`. Returns True on success."""
    # Only an EXPIRED URL is worth a second attempt: re-resolving costs another
    # ~1-2s yt-dlp subprocess, and it cannot repair a deterministic failure (an
    # oversized track, an unbounded first chunk). Those fall straight through to
    # the proxy instead of paying the resolve twice on every play.
    for attempt in range(2):
        url = _resolve_stream_url(video_id, source, force=(attempt == 1))
        if not url:
            return False
        try:
            return _download_chunked(url, dest)
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 410) and attempt == 0:
                continue  # expired signed URL — re-resolve and retry
            return False
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
            # http.client.HTTPException covers IncompleteRead, which a truncated
            # upstream raises and which is NOT an OSError — uncaught, it would
            # kill the request thread instead of falling back to the proxy.
            return False
    return False


def _download_chunked(url, dest):
    """Write the complete resource at `url` into `dest` via bounded Range chunks.

    Returns True ONLY when every byte landed. Every other outcome — an empty
    first chunk, a track over STREAM_FETCH_MAX_BYTES, an upstream that answers
    a chunk short — returns False and leaves `dest` to the caller to discard.
    A partial file must never be reported as success: it would be remuxed and
    cached as a truncated track.
    """
    first, total = _range_get(url, 0, _CHUNK_BYTES - 1, cap=STREAM_FETCH_MAX_BYTES)
    if not first:
        return False
    with open(dest, "wb") as fh:
        fh.write(first)
        if total == -1:
            # Upstream ignored Range and sent everything. _range_get already
            # bounded that body at STREAM_FETCH_MAX_BYTES.
            return fh.tell() > 0
        if total is None:
            total = len(first) if len(first) < _CHUNK_BYTES else None
            if total is None:
                return False  # a full chunk with no total: cannot bound the fetch
            return True
        if total > STREAM_FETCH_MAX_BYTES:
            return False
        offset = len(first)
        while offset < total:
            starts = []
            for _ in range(_CHUNK_PARALLEL):
                start = offset + _CHUNK_BYTES * len(starts)
                if start >= total:
                    break
                starts.append(start)
            bodies = list(
                _chunk_pool.map(
                    lambda s: _range_get(s[0], s[1], min(s[1] + _CHUNK_BYTES, total) - 1)[0],
                    [(url, start) for start in starts],
                )
            )
            # Every chunk is written AT ITS OWN OFFSET and must be exactly the
            # length that was asked for. A server is allowed to answer a Range
            # with fewer bytes than requested; appending such a body in sequence
            # would splice the audio — the download would still reach `total`
            # and the corrupt result would be remuxed, cached, and served to
            # every later play of that track. Refuse instead: the caller falls
            # back to the proxy, which still plays.
            for start, body in zip(starts, bodies):
                if len(body) != min(start + _CHUNK_BYTES, total) - start:
                    return False
                fh.seek(start)
                fh.write(body)
            offset = min(starts[-1] + _CHUNK_BYTES, total)
        return offset >= total


def _build_stream_cache(video_id, source):
    """Fetch + remux to a progressive MP4 at the cache path. Returns the path,
    or None if any step failed (the caller then falls back to proxying)."""
    final = _stream_cache_path(video_id)
    lock = _remux_lock_for(video_id)
    with lock:
        if os.path.exists(final) and os.path.getsize(final) > 0:
            return final  # another thread built it while we waited
        os.makedirs(STREAM_CACHE_DIR, exist_ok=True)
        raw = f"{final}.raw.{uuid.uuid4().hex}"
        out = f"{final}.out.{uuid.uuid4().hex}"
        t0 = time.monotonic()
        try:
            if not _fetch_upstream_to(video_id, source, raw):
                print(f"[stream] fetch failed for {video_id}", flush=True)
                return None
            t_fetch = time.monotonic()
            try:
                proc = subprocess.run(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-v", "error",
                        "-y",
                        "-i", raw,
                        "-map", "0:a:0",
                        "-c", "copy",
                        "-movflags", "+faststart",
                        "-f", "mp4",
                        out,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=REMUX_TIMEOUT_S,
                )
            except subprocess.SubprocessError:
                return None
            if proc.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
                # Loud on purpose: a silent failure here degrades every play on
                # this track back to the fragmented bytes, invisibly.
                print(
                    f"[stream] remux failed for {video_id}: "
                    f"rc={proc.returncode} {(proc.stderr or '').strip()[:300]}",
                    flush=True,
                )
                return None
            os.replace(out, final)
            # Timings on every build: this path has a latency budget the user can
            # feel (it runs before the first byte of audio), and the throttle it
            # works around is invisible from anywhere else.
            print(
                f"[stream] built {video_id} bytes={os.path.getsize(final)} "
                f"fetch={t_fetch - t0:.2f}s remux={time.monotonic() - t_fetch:.2f}s",
                flush=True,
            )
        except OSError:
            return None
        finally:
            for tmp in (raw, out):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
    _prune_stream_cache()
    return final


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

# A bare playlist id. The leading character is constrained separately so an id can
# never begin with `-`: the value is passed to yt-dlp as a positional argv element,
# and `-rm-cache-dir`-shaped input would be read as a FLAG rather than a URL.
_PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{9,}$")

# The only hosts a playlist may resolve from. Anything else was an SSRF: the URL
# was returned verbatim and handed straight to `yt-dlp <url>`, and this container
# sits on both the media-automation and jellyfin networks — so any authenticated
# user could make it issue GETs to radarr:7878, sonarr:8989, prowlarr:9696,
# qbittorrent:8080, jellyfin:8096 and jellyseerr:5055. Blind, but the
# resolve_failed / empty / 202 distinction is a clean oracle for host+port
# scanning, and any internal side effects fired for real.
_PLAYLIST_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
    }
)


def _normalize_playlist_url(url):
    """Accept a full YouTube playlist URL or a bare playlist id, or return None.

    The host is parsed, never substring-matched: `https://evil.test/?x=youtube.com`
    contains the allowed name and must still be refused.
    """
    url = (url or "").strip()
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        try:
            host = (urllib.parse.urlsplit(url).hostname or "").lower()
        except ValueError:
            return None
        if host in _PLAYLIST_HOSTS:
            return url
        return None
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


# ---------------------------------------------------------------------------
# Radio mix
#
# The old radio was one line: get_watch_playlist(seed). That is YouTube Music's
# autoplay queue for a SINGLE video, and it behaves exactly as advertised — it
# returns mostly the seed's own artist and runs dry after a handful of tracks.
# The report was "busco un artista, reproduzco, y sólo me salen unas diez
# canciones del mismo artista". The API was doing its job; the job was too small.
#
# Meanwhile this worker already stored everything a real radio needs and read
# none of it: a per-user play tally with artists and counts (_plays), and a
# per-user thumb vote (_ratings) whose UP half had NO READER ANYWHERE — pressing
# it changed nothing about what you were served next.
#
# So a radio is now a mix of independent sources, interleaved round-robin:
#
#   seed        the old behaviour, kept but capped
#   related     get_song_related — "you might also like", genre-adjacent
#   artists     the artists you actually play most, from _plays
#   likes       a radio seeded from a track you thumbed UP
#   history     something you have played before, resurfaced
#
# **Round-robin is the part that fixes the complaint.** Concatenating the
# sources and truncating would still return ten seed-artist tracks, because the
# seed radio is the longest list and would fill the whole window on its own.
# ---------------------------------------------------------------------------

# A slow source must never hold the whole radio: whatever answered in time is a
# better radio than a spinner.
RADIO_SOURCE_TIMEOUT_S = float(os.environ.get("RADIO_SOURCE_TIMEOUT_S", "8"))
RADIO_CACHE_TTL_S = float(os.environ.get("RADIO_CACHE_TTL_S", "600"))
# The share of one radio any SINGLE artist may take. Capping only the seed's
# artist was not enough in practice: a mixed radio for a Colombian popular track
# still came back 5/12 Yeison Jimenez, because he was not the seed artist — he
# was simply who every source happened to agree on. The complaint is "sólo me
# salen canciones del mismo artista", and it does not care which one.
ARTIST_MAX_SHARE = 0.30

_radio_cache = {}
_radio_cache_lock = threading.Lock()


def _radio_cached(key):
    with _radio_cache_lock:
        hit = _radio_cache.get(key)
        if hit and hit[1] > time.time():
            return hit[0]
    return None


def _radio_store(key, value):
    with _radio_cache_lock:
        # Bounded so a long-lived worker cannot grow this without limit; radios
        # are cheap to rebuild and stale ones are worth less than memory.
        if len(_radio_cache) > 256:
            _radio_cache.clear()
        _radio_cache[key] = (value, time.time() + RADIO_CACHE_TTL_S)


def _src_seed(yt, seed, want):
    """The seed's own autoplay queue, plus the browseId that unlocks `related`.

    Returns (tracks, related_browse_id) so the caller gets both from one round
    trip — get_song_related needs an id that only this response carries.
    """
    if not seed:
        return [], None
    wp = yt.get_watch_playlist(videoId=seed, limit=want + 5) or {}
    tracks = [
        _map_watch_track(t)
        for t in (wp.get("tracks") or [])
        if t.get("videoId") and t.get("videoId") != seed
    ]
    return tracks, wp.get("related")


def _src_related(yt, related_browse_id, want):
    """Genre-adjacent material: YouTube's own "you might also like" for a song.

    This is the source that makes the radio stop sounding like one artist's
    discography, so it is worth the extra call even though it needs the seed
    call to have happened first.
    """
    if not related_browse_id:
        return []
    out = []
    for section in (yt.get_song_related(related_browse_id) or []):
        for item in (section.get("contents") or []):
            if item.get("videoId"):
                out.append(_map_song(item))
            if len(out) >= want:
                return out
    return out


def _src_your_artists(yt, user_id, want):
    """Songs by the artists this user actually plays most.

    Ranked by play count rather than recency: the point is "your artists", and
    one obsessive evening should not outrank a year of listening.
    """
    if not user_id:
        return []
    tally = {}
    for row in user_plays(user_id):
        artist = (row.get("artist") or "").strip()
        if artist:
            tally[artist] = tally.get(artist, 0) + int(row.get("count") or 0)
    if not tally:
        return []
    top = sorted(tally, key=tally.get, reverse=True)[:3]
    out = []
    for artist in top:
        try:
            out.extend(_ytmusic_songs(artist, max(2, want // len(top) + 1)))
        except Exception:  # noqa: BLE001 — one dead artist must not kill the mix
            continue
    return out[:want]


def _src_your_likes(yt, user_id, want):
    """A radio seeded from something this user thumbed UP.

    Until this existed the thumb-up was a button that lied: the only reader of
    the vote table was _drop_disliked, which looks at -1 and nothing else. A
    like now buys you more music like the thing you liked, which is the only
    meaning the gesture ever had.
    """
    if not user_id:
        return []
    liked = [vid for vid, vote in user_ratings(user_id).items() if vote == 1]
    if not liked:
        return []
    # Rotate through likes rather than always seeding from the same one, or the
    # radio would be identical every time until the user liked something new.
    pick = liked[int(time.time() // RADIO_CACHE_TTL_S) % len(liked)]
    wp = yt.get_watch_playlist(videoId=pick, limit=want + 2) or {}
    return [
        _map_watch_track(t)
        for t in (wp.get("tracks") or [])
        if t.get("videoId") and t.get("videoId") != pick
    ][:want]


def _src_history(user_id, want):
    """Tracks this user has played before. No network call — the tally already
    holds title, artist and length, which is why it was stored that way."""
    if not user_id:
        return []
    out = []
    for row in user_plays(user_id):
        if not row.get("videoId") or not row.get("title"):
            continue
        out.append({
            "type": "song",
            "videoId": row["videoId"],
            "title": row.get("title"),
            "artist": row.get("artist"),
            "artists": [row["artist"]] if row.get("artist") else [],
            "album": None,
            "durationSeconds": row.get("seconds") or None,
            "thumbnailUrl": None,
            "source": "ytmusic",
        })
        if len(out) >= want:
            break
    return out


def _interleave(sources, limit):
    """Round-robin the sources into one deduped list, with every artist capped.

    Two rules, and the radio is bad without either:

    Round-robin, because taking the sources in order and truncating would let
    the longest one fill the whole window — and the longest is the seed radio,
    so the result would be indistinguishable from the old one-line version.

    A per-artist ceiling, because round-robin alone does not stop one artist
    winning: if several sources independently return the same popular name, they
    each contribute him and he takes half the radio anyway.

    When the sources are too thin to fill the radio under the cap, the cap is
    raised ONE step at a time and the first setting that fills wins. Dropping
    straight to "no cap" instead — the obvious version — undoes the whole thing:
    on real data it turned a 3-per-artist radio into 8 of 12 by one artist, the
    exact complaint, just to gain the last track.
    """
    cap = max(1, int(limit * ARTIST_MAX_SHARE))
    lists = [list(s) for s in sources if s]

    def sweep(artist_cap):
        out, seen, used = [], set(), {}
        index = 0
        while lists and len(out) < limit:
            progressed = False
            for tracks in lists:
                if index >= len(tracks):
                    continue
                progressed = True
                row = tracks[index]
                vid = row.get("videoId")
                if not vid or vid in seen:
                    continue
                artist = (row.get("artist") or "").strip().lower()
                if artist and used.get(artist, 0) >= artist_cap:
                    continue
                if artist:
                    used[artist] = used.get(artist, 0) + 1
                seen.add(vid)
                out.append(row)
                if len(out) >= limit:
                    break
            if not progressed:
                break
            index += 1
        return out

    best = sweep(cap)
    relaxed = cap
    while len(best) < limit and relaxed < limit:
        relaxed += 1
        candidate = sweep(relaxed)
        if len(candidate) <= len(best):
            break  # more room bought nothing: the material really is exhausted
        best = candidate
    return best


def recommendations(seed, limit, user_id=None):
    """A mixed radio for a seed videoId, personalised for `user_id`.

    Best-effort throughout: every source is allowed to fail on its own and the
    radio is built from whatever answered. A partial radio beats an error.
    """
    try:
        yt = _get_ytmusic()
    except Exception:  # noqa: BLE001
        return []

    if not seed:
        seed = _recent_seed_video()

    cache_key = (seed or "", user_id or "", limit)
    cached = _radio_cached(cache_key)
    if cached is not None:
        return cached

    # Fetched first and alone because its response carries the browseId that
    # _src_related needs; everything else can then run in parallel.
    seed_tracks, related_id = [], None
    if seed:
        try:
            seed_tracks, related_id = _src_seed(yt, seed, limit)
        except Exception:  # noqa: BLE001
            seed_tracks, related_id = [], None

    jobs = {
        "related": lambda: _src_related(yt, related_id, limit),
        "artists": lambda: _src_your_artists(yt, user_id, limit),
        "likes": lambda: _src_your_likes(yt, user_id, limit),
    }
    gathered = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {pool.submit(fn): name for name, fn in jobs.items()}
        for future in concurrent.futures.as_completed(futures, timeout=None):
            name = futures[future]
            try:
                gathered[name] = future.result(timeout=RADIO_SOURCE_TIMEOUT_S) or []
            except Exception:  # noqa: BLE001 — a dead source is not a dead radio
                gathered[name] = []

    # History last: it is the weakest signal (you have heard it already) and
    # costs nothing, so it is the natural filler when the network sources come
    # back thin.
    sources = [
        seed_tracks,
        gathered.get("related") or [],
        gathered.get("artists") or [],
        gathered.get("likes") or [],
        _src_history(user_id, limit),
    ]

    results = _interleave(sources, limit)

    # With no seed and nothing personal to go on there is nothing to mix, so
    # fall back to YouTube's own home picks rather than returning an empty list.
    if not results:
        try:
            results = _home_recommendations(yt, limit)
        except Exception:  # noqa: BLE001
            results = []

    # Never cache an empty radio. Every source here is best-effort, so "empty"
    # usually means a transient failure — and pinning that for the cache TTL
    # would turn a five-second blip into ten minutes of a dead rail.
    if results:
        _radio_store(cache_key, results)
    return results


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

    def _serve_cached_stream(self, path, range_header):
        """Serve a locally cached progressive MP4, honouring a single byte Range.
        Returns False if the file vanished under us (caller falls back).

        The file is OPENED BEFORE anything is sent, and its length is taken from
        that open descriptor. Both matter: LRU pruning can unlink a cache entry
        at any moment, and on Linux an open descriptor keeps reading the unlinked
        inode, so the body can never come up short against the Content-Length
        already promised on a keep-alive connection.
        """
        try:
            handle = open(path, "rb")  # noqa: SIM115 — closed in the finally below
        except OSError:
            return False
        try:
            return self._serve_open_stream(handle, range_header)
        finally:
            try:
                handle.close()
            except OSError:
                pass

    def _serve_open_stream(self, handle, range_header):
        try:
            size = os.fstat(handle.fileno()).st_size
        except OSError:
            return False
        if size <= 0:
            return False
        start, end, status = 0, size - 1, 200
        if range_header:
            # A Range this does not understand (multi-range, or a malformed one)
            # is answered with the whole file, which is always a legal response.
            # It must NEVER fall back to proxying: that would hand this one
            # request the fragmented bytes and the doubled duration back.
            # The digit count is BOUNDED on purpose. Python 3.12 refuses to
            # int() a string of more than sys.int_info.default_max_str_digits
            # (4300) digits and raises ValueError; with an unbounded \d* a
            # client sending `bytes=<4301 nines>-0` reached int() below, and
            # the exception escaped do_GET and killed the connection with a
            # traceback. 19 digits covers every real file size.
            match = re.match(r"^bytes=(\d{0,19})-(\d{0,19})$", range_header.strip())
            if match and (match.group(1) or match.group(2)):
                first, last = match.group(1), match.group(2)
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                else:  # suffix range: the final N bytes
                    start = max(0, size - int(last))
                end = min(end, size - 1)
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return True
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "audio/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client seeked or closed the tab — normal for audio playback
        except OSError:
            # Headers are already out and the body is short of the promised
            # Content-Length, so this connection can no longer be trusted for a
            # following request. Drop it rather than desync the framing.
            self.close_connection = True
        return True

    def _stream(self, qs):
        """Instant-play: serve the videoId's audio WITHOUT a prior download.

        Served from the progressive remux cache (see _build_stream_cache) so an
        iPhone gets a file with exactly one declared duration; only if building
        that fails does it fall back to range-proxying the fragmented upstream."""
        video_id = (qs.get("videoId", [""])[0]).strip()
        if not video_id:
            return self._send(400, {"error": "videoId required"})
        if not _VIDEO_ID_RE.match(video_id):
            return self._send(400, {"error": "invalid videoId"})
        source = (qs.get("source", ["auto"])[0]).strip().lower()
        if source not in ("auto", "ytmusic", "youtube"):
            source = "auto"
        range_header = self.headers.get("Range")

        cached = _stream_cache_path(video_id)
        try:
            if not (os.path.exists(cached) and os.path.getsize(cached) > 0):
                cached = _build_stream_cache(video_id, source)
        except Exception as exc:  # noqa: BLE001
            # Nothing raised out of the build is worth killing the request for —
            # the proxy below still plays the track. Loud, because a build that
            # always throws would otherwise look like a permanently slow track.
            print(f"[stream] build raised for {video_id}: {exc!r}", flush=True)
            cached = None
        if cached:
            try:
                os.utime(cached, None)  # LRU touch
            except OSError:
                pass
            if self._serve_cached_stream(cached, range_header):
                return

        # Fallback: the remux failed (upstream gone, ffmpeg error). Proxy the
        # fragmented bytes as before — a doubled duration beats no audio.
        # The _neutralize_sidx call further down does NOT repair that duration:
        # it was refuted on-device twice (see the remux comment above). It is
        # kept only because it is free and harmless, not because it works.
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
            # Only patch when serving from the start of the resource. A ranged
            # request that begins mid-file cannot contain the sidx header, and
            # rewriting bytes at an unknown offset would corrupt the stream.
            sent = 0
            patch = not upstream.headers.get("Content-Range") or str(
                upstream.headers.get("Content-Range", "")
            ).startswith("bytes 0-")
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                if patch:
                    chunk = _neutralize_sidx(chunk, sent)
                sent += len(chunk)
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client seeked or closed the tab — normal for audio playback
        except (http.client.HTTPException, urllib.error.URLError, OSError):
            # A truncated upstream raises IncompleteRead, which is NOT an
            # OSError. Uncaught it escapes do_GET and socketserver tears the
            # socket down with a traceback; the headers are already sent, so the
            # honest end is to drop this connection and stop.
            self.close_connection = True
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
            user_id = self._user_id()
            # `ratings` keeps its old shape so every existing caller is
            # untouched; `liked` is the renderable list "Tus me gusta" needs.
            return self._send(200, {
                "ratings": user_ratings(user_id),
                "liked": _annotate_downloaded(user_liked(user_id)),
            })

        if path == "/plays":
            return self._send(200, {"plays": user_plays(self._user_id())})

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
            # Resolved BEFORE the call now: the radio is personalised (your
            # artists, your likes, your history), so it needs to know whose.
            user_id = self._user_id()
            try:
                results = recommendations(seed, limit, user_id)
            except Exception:  # noqa: BLE001 — recommendations are best-effort.
                results = []
            # A radio that keeps serving what you rejected is the whole reason
            # the thumb-down exists, so this filter runs before anything else.
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
        if parsed.path not in ("/downloads", "/playlists", "/ratings", "/plays"):
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
            # The client holds the title and artist at the moment the thumb is
            # pressed. Taking them here is what lets "Tus me gusta" render a
            # track instead of an id, with no extra YouTube round trip.
            stored = set_rating(
                self._user_id(),
                video_id,
                rating,
                title=(payload.get("title") or "").strip() or None,
                artist=(payload.get("artist") or "").strip() or None,
                thumb=(payload.get("thumbnailUrl") or "").strip() or None,
            )
            return self._send(200, {"videoId": video_id, "rating": stored})

        if parsed.path == "/plays":
            video_id = (payload.get("videoId") or "").strip()
            if not video_id:
                return self._send(400, {"error": "missing_video_id"})
            try:
                seconds = int(payload.get("seconds") or 0)
            except (TypeError, ValueError):
                seconds = 0
            count = record_play(
                self._user_id(),
                video_id,
                (payload.get("title") or "").strip(),
                (payload.get("artist") or "").strip(),
                seconds,
            )
            return self._send(200, {"videoId": video_id, "count": count})

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
