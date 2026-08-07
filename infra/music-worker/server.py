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
import math
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


# --- iOS fMP4 duration patch (REMOVED) --------------------------------------
# YouTube only serves DASH-fragmented audio (every format is `*_dash`), and those
# files carry the total duration TWICE: once in `moov/mvhd` and again in the
# fragment timeline. iOS WebKit ADDS them, so a 3:14 track reports as 6:26 — the
# audio ends on time while the timer runs on through phantom silence.
#
# Renaming the redundant box to `free` looked like the surgical repair: `free` is
# padding every demuxer skips, the box KEEPS ITS LENGTH, so no byte offset moves
# and Range requests stay valid. It was shipped twice, for `sidx` and then for
# `edts`, and the DEVICE refuted both — with neither box in the delivered bytes
# an iPhone still reported exactly 2x (322.926s for a 162s track):
#
#     mvhd 161.469s + elst 161.469s = 322.938s   (Mi Comedia, ~161s of dead air)
#
# The real fix is to stop serving a fragmented file at all — see the progressive
# remux cache below. There is no fallback path left for this patch to serve: a
# remux that fails validation now fails the TRACK (explicit error, client skips
# it) instead of reviving the fragmented bytes this patch used to paper over.
# Serving those bytes "because a doubled duration beats no audio" was the bug:
# a doubled duration means `ended` never fires on time, so the queue never
# advances and the whole session hangs — one skipped track is recoverable, a
# hung session is not.


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
    #
    # Best-effort, but no longer silent: the caller still gets its 200 whatever
    # happens here, so a swallowed write meant votes could vanish on the next
    # restart with nothing anywhere to say so. A read-only volume, a full disk
    # or a bad DATA_DIR now leaves a line in the log.
    try:
        tmp = RATINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_ratings, fh)
        os.replace(tmp, RATINGS_PATH)
    except OSError as exc:
        print(f"[ratings] could not persist to {RATINGS_PATH}: {exc}", flush=True)


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


# How many bare likes a single pass repairs. Someone who liked two hundred
# tracks on an older client would otherwise turn one screen into two hundred
# upstream lookups; the remainder heal on the next read.
LIKED_BACKFILL_PER_READ = 12

# Wall clock for one pass. The per-call ceiling above bounds each lookup; this
# bounds the pass, so a uniformly slow upstream cannot keep a worker thread
# alive for minutes on end.
LIKED_BACKFILL_BUDGET_S = 20

# Users with a repair pass already running. One is plenty: `GET /ratings` is
# refetched on mount and every five minutes, so without this a slow upstream
# would stack a fresh set of lookups on top of the ones still in flight.
_repair_inflight = set()
_repair_inflight_lock = threading.Lock()


def repair_liked_metadata(user_id):
    """Kick off the repair without making the caller wait for YouTube.

    This is called from the `GET /ratings` handler, which the app hits on
    mount and every five minutes — not just when "Tus me gusta" is on screen.
    Doing the lookups inline meant up to `LIKED_BACKFILL_PER_READ` sequential
    requests to a scraped third party sat between the user and their own
    ratings, and nothing downstream would have cut it short: `apiFetch` sends
    no `AbortSignal` and the Caddyfile sets no timeout for `/bff/*`. A slow
    upstream would simply hang the screen.

    So the read answers immediately from what is already stored, and the
    repair lands in the next refetch a few minutes later. A bare videoId
    showing for one cycle is a far smaller defect than a stalled screen.
    """
    if not user_id:
        return
    with _repair_inflight_lock:
        if user_id in _repair_inflight:
            return
        _repair_inflight.add(user_id)

    def run():
        try:
            _repair_liked_metadata_now(user_id)
        finally:
            with _repair_inflight_lock:
                _repair_inflight.discard(user_id)

    threading.Thread(target=run, name="liked-repair", daemon=True).start()


def _repair_liked_metadata_now(user_id):
    """Fill in title/artist/thumbnail for likes that were stored without them.

    `user_liked` falls back to the raw videoId when a row has no title, which
    is exactly what put bare ids and "Desconocido" on the "Tus me gusta"
    screen. Metadata normally rides along with the vote, but a row written by
    an older client -- or by any caller that omits it -- has no other way back:
    nothing in this worker ever resolved a bare id after the fact.

    The answer is written back, so a repaired row costs one lookup ever rather
    than one per page view.

    Best-effort by design: an upstream failure leaves the old fallback in
    place rather than raising. Runs on a background thread — see
    `repair_liked_metadata`, which is what callers should use.
    """
    if not user_id:
        return
    with _ratings_lock:
        bare = [
            vid
            for vid, row in _ratings.get(user_id, {}).items()
            if row.get("v") == 1 and not row.get("title")
        ][:LIKED_BACKFILL_PER_READ]
    if not bare:
        return

    try:
        yt = _get_ytmusic()
    except Exception:  # noqa: BLE001
        return

    resolved = {}
    deadline = time.monotonic() + LIKED_BACKFILL_BUDGET_S
    for video_id in bare:
        if time.monotonic() >= deadline:
            # Whatever resolved so far still gets written; the rest are picked
            # up by the next pass rather than held hostage to a slow upstream.
            break
        try:
            watch = yt.get_watch_playlist(videoId=video_id, limit=1) or {}
        except Exception:  # noqa: BLE001
            # One dead id must not stop the others from healing.
            continue
        for track in watch.get("tracks", []) or []:
            if track.get("videoId") != video_id:
                continue
            song = _map_song(track)
            if song.get("title"):
                resolved[video_id] = song
            break

    if not resolved:
        return

    with _ratings_lock:
        votes = _ratings.get(user_id) or {}
        for video_id, song in resolved.items():
            row = votes.get(video_id)
            if not row:
                # Vote cleared while we were asking YouTube.
                continue
            # Only ever added, never blanked -- the same rule `set_rating`
            # follows, so a repair can't overwrite something better.
            for key, value in (
                ("title", song.get("title")),
                ("artist", song.get("artist")),
                ("thumb", song.get("thumbnailUrl")),
            ):
                if isinstance(value, str) and value and not row.get(key):
                    row[key] = value
        _persist_ratings()


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
    # Called under _plays_lock. Best-effort, mirrors _persist_ratings — and
    # says so out loud when it fails, for the same reason: this tally is what
    # seeds the whole personalised feed, so losing it silently reads to the
    # user as "the app forgot everything I listened to".
    try:
        tmp = PLAYS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_plays, fh)
        os.replace(tmp, PLAYS_PATH)
    except OSError as exc:
        print(f"[plays] could not persist to {PLAYS_PATH}: {exc}", flush=True)


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

# Ceiling for a single YouTube Music call. Generous — these are scraped
# endpoints and a slow answer is still an answer — but finite.
YTMUSIC_TIMEOUT_S = 15


def _get_ytmusic():
    global _ytmusic
    if _ytmusic is None:
        import requests
        from ytmusicapi import YTMusic

        class _TimeoutSession(requests.Session):
            """A session that refuses to wait forever.

            `YTMusic(...)` exposes no timeout of its own — it only accepts a
            prepared session — so an upstream that accepts the connection and
            then stops talking hangs the calling thread for good. Every other
            network call in this file is already bounded (`timeout=30` on the
            Jellyfin and stream fetches, proportional ceilings on ffmpeg);
            this closes the one hole left, for every ytmusicapi call at once.
            """

            def request(self, *args, **kwargs):
                kwargs.setdefault("timeout", YTMUSIC_TIMEOUT_S)
                return super().request(*args, **kwargs)

        _ytmusic = YTMusic(requests_session=_TimeoutSession())
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
    cached (STREAM_URL_TTL). Prefers AAC (avoids the transcode in
    `_build_stream_cache` entirely — see ROUND 2 BLOQUEANTE notes there),
    falling back to whatever bestaudio yt-dlp finds when nothing AAC-coded is
    available.

    The format selector matches by `acodec^=mp4a` (the actual declared codec
    family, "mp4a.40.2" for AAC-LC) as the FIRST choice, ahead of the
    `ext=m4a` container-extension match that used to be the only AAC
    criterion — insisting on the real codec rather than a proxy for it, per
    the audit's request to reach for AAC more aggressively before falling
    back to Opus. Verified empirically against real, current YouTube
    responses (a well-known video plus 5 videos uploaded the same week this
    was written, both as plain youtube.com and music.youtube.com watch URLs):
    every one of them exposed itag 140 (`mp4a.40.2`, 130kbps) alongside the
    Opus itags, and this selector picked it. No opus-only video was found in
    that sample, so the case this worker's transcode path exists for could
    not be reproduced live — the selector is hardened defensively, but the
    transcode path (with its own fast-coder + proportional-timeout fix, see
    below) remains the real safety net for whatever videos DO lack an AAC
    format."""
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
                "bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio",
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
# Fallback timeout used only when the source duration is unknown (unreadable
# probe) — see REMUX_TIMEOUT_PER_SECOND below for the normal, duration-aware
# path. `-c copy` remuxes never get anywhere near this; it only bounds the
# rare case where a transcode has to run without knowing how long it will take.
REMUX_TIMEOUT_S = 120
# A videoId reaches the filesystem as a path component, so it is constrained to
# the alphabet YouTube actually uses. Without this a crafted id is a traversal.
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{5,32}$")

# --- Transcode timeout: proportional, not fixed ------------------------------
# Measured against real ffmpeg 8.0.1 on an i7-1270P (reported by the audit):
# transcoding a 210s/3:30 track to AAC took 46.0s at 1 CPU core. The native
# AAC encoder has no threading ("Threading capabilities: none" per
# `ffmpeg -h encoder=aac`, confirmed in this environment too), so its cost
# scales with audio DURATION, not file size or core count. At that rate
# (~0.219s of encode time per second of source audio), a FIXED 120s timeout
# guarantees eventual failure: any track past ~9 minutes at 1 core hits it,
# and proportionally less on weaker hardware. Since the fragmented-bytes
# fallback is gone, that timeout used to kill the track PERMANENTLY — every
# retry repeats the identical fetch+encode and times out again.
#
# REMUX_TIMEOUT_PER_SECOND=1.0 leaves more than 2x headroom over even the
# audit's own "half speed" estimate for weaker hardware (~0.44s/s), while
# REMUX_TIMEOUT_FLOOR_S protects very short clips from an unreasonably tight
# budget and REMUX_TIMEOUT_CEILING_S bounds the worst case for a pathological
# input rather than blocking a worker thread indefinitely.
REMUX_TIMEOUT_FLOOR_S = 30.0
REMUX_TIMEOUT_PER_SECOND = 1.0
REMUX_TIMEOUT_CEILING_S = 600.0


def _remux_timeout_for(duration):
    """Proportional ffmpeg subprocess timeout for `duration` seconds of
    source audio. Falls back to the fixed REMUX_TIMEOUT_S when duration is
    unknown — an unreadable probe is not evidence the track is short, but
    that only matters for the transcode branch: the `-c copy` remux never
    gets close to either value."""
    if not duration or duration <= 0 or not math.isfinite(duration):
        return REMUX_TIMEOUT_S
    return min(REMUX_TIMEOUT_CEILING_S, max(REMUX_TIMEOUT_FLOOR_S, duration * REMUX_TIMEOUT_PER_SECOND))


# --- Transcode timeout: non-terminal ------------------------------------------
# A timeout is not proof a track can never be encoded — it may just mean this
# ATTEMPT hit unlucky system load, or a genuinely slow-worst-case source. A
# video_id that has timed out once gets a cheaper (lower-bitrate) encode on
# its NEXT attempt instead of repeating the identical, already-failed path —
# a real chance of finishing where the first attempt did not, not just a
# retry of the exact same doomed work. Cleared on the next successful build so
# a one-off timeout (e.g. transient host load) does not permanently degrade
# quality for a track that turns out to encode fine most of the time.
_transcode_timeout_guard = threading.Lock()
_transcode_timeout_counts = {}  # video_id -> consecutive-timeout count
_TRANSCODE_TIMEOUT_TRACKED_MAX = 500  # bounded, same spirit as _remux_locks


def _record_transcode_timeout(video_id):
    with _transcode_timeout_guard:
        if len(_transcode_timeout_counts) > _TRANSCODE_TIMEOUT_TRACKED_MAX:
            # A burst of distinct timed-out ids is itself a signal something
            # bigger is wrong (overloaded host); simplest bound is to reset
            # rather than grow forever or evict arbitrarily.
            _transcode_timeout_counts.clear()
        _transcode_timeout_counts[video_id] = _transcode_timeout_counts.get(video_id, 0) + 1


def _clear_transcode_timeout(video_id):
    with _transcode_timeout_guard:
        _transcode_timeout_counts.pop(video_id, None)


def _aac_transcode_args(video_id):
    """AAC encode args for `video_id`. `-aac_coder fast` is always on:
    measured (real ffmpeg 8.0.1, this environment) at ~34-42% faster than the
    default `twoloop` search, with no change to output validity. On top of
    that, a video_id that has already timed out once gets a lower target
    bitrate — genuinely cheaper for the encoder to search, not the same
    settings repeated."""
    with _transcode_timeout_guard:
        attempts = _transcode_timeout_counts.get(video_id, 0)
    bitrate = "128k" if attempts >= 1 else "192k"
    return ["-c:a", "aac", "-aac_coder", "fast", "-b:a", bitrate]

# --- Output validation (ffprobe) ---------------------------------------------
# `returncode == 0` from ffmpeg is NOT proof of a playable file. Verified case:
# ffmpeg 8.0.1 happily muxes an Opus stream into an MP4 container and exits 0 —
# iOS cannot decode that, and nothing before this validation would have noticed.
# ffprobe's structured report is the ground truth this worker actually reads
# instead of trusting a process exit code.
PROBE_TIMEOUT_S = 15
# Codecs iOS/Safari are known to decode inside the containers this worker
# produces. Opus is deliberately excluded even though ffmpeg will mux it
# without complaint — see the module docstring above.
EXPECTED_AUDIO_CODECS = {"aac", "mp3", "alac"}
# ffprobe reports an MP4/M4A container's format_name as the combined
# "mov,mp4,m4a,3gp,3g2,mj2" string, not a single token — matching by substring
# is the only way that does not need an exact, brittle match.
EXPECTED_CONTAINER_TOKENS = ("mp4", "m4a", "mov", "mp3")
CODEC_CONTENT_TYPE = {"aac": "audio/mp4", "alac": "audio/mp4", "mp3": "audio/mpeg"}
# The device-observed defect is an EXACT 2x (322.926s for a 162s track). This
# window is deliberately wide enough to catch that class of bug while staying
# clear of legitimate encoder rounding.
DUPLICATE_DURATION_RATIO = (1.8, 2.2)


def _probe_media(path):
    """Run ffprobe against `path` and return
    {"codecs": [str, ...], "format_name": str, "duration": float|None}, or
    None if ffprobe itself failed or its output could not be parsed.

    `codecs` deliberately lists AUDIO streams only. yt-dlp's
    `--embed-thumbnail --convert-thumbnail jpg` (see `_run_download`) leaves
    an mjpeg `covr` atom in every downloaded `.m4a`, which ffprobe reports as
    a perfectly ordinary second stream (codec_type "video",
    disposition.attached_pic=1). Verified against real ffmpeg 8.0.1: a plain
    aac+mjpeg-cover file probes to codecs ["aac", "mjpeg"] if streams aren't
    filtered by type — an embedded cover is desirable, not a defect, and
    counting it against EXPECTED_AUDIO_CODECS deleted every download that had
    one (which is every download, by default). Any stream whose codec_type
    isn't "audio" is excluded regardless of its codec name or disposition, so
    this also covers attached images that ffprobe might not flag as
    attached_pic for whatever reason.

    This is the only place in the worker that inspects what actually landed
    on disk, rather than trusting a subprocess exit code.
    """
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "stream=codec_name,codec_type",
                "-show_entries", "stream_disposition=attached_pic",
                "-show_entries", "format=format_name,duration",
                "-of", "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
        )
    except subprocess.SubprocessError:
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    streams = data.get("streams")
    streams = streams if isinstance(streams, list) else []
    codecs = []
    for s in streams:
        if not isinstance(s, dict) or not s.get("codec_name"):
            continue
        if s.get("codec_type") != "audio":
            continue  # attached cover art, or any other non-audio stream
        disposition = s.get("disposition")
        if isinstance(disposition, dict) and disposition.get("attached_pic"):
            continue  # belt-and-braces: an "audio"-typed attached pic, if that ever happens
        codecs.append(s.get("codec_name"))
    fmt = data.get("format")
    fmt = fmt if isinstance(fmt, dict) else {}
    format_name = fmt.get("format_name") or ""
    try:
        duration = float(fmt.get("duration"))
    except (TypeError, ValueError):
        duration = None
    return {"codecs": codecs, "format_name": format_name, "duration": duration}


def _validate_audio_output(video_id, out_path, raw_path=None, label="remux"):
    """The real acceptance gate for any audio file this worker is about to
    serve or keep. Returns the Content-Type to serve it with on success, or
    None on any failure — logged loudly so a maintainer can see WHY a track
    was rejected instead of it silently degrading.

    `raw_path`, when given, is probed too so the doubled-duration defect can
    be caught directly: an output whose OWN reported duration comes out ~2x
    its source's is exactly the device-observed defect this validation exists
    to keep off the wire, not merely a nonzero ffmpeg exit code.

    This cross-check assumes `raw_path` is a COMPLETE file, never a partial
    one — otherwise a fragmented (DASH-style) raw source that only exposed a
    partial/init-segment duration to ffprobe would make a perfectly good
    full-length output look ~2x too long and get rejected by mistake. That
    assumption holds structurally in this codebase: every caller of this
    function only ever passes a `raw_path` that `_download_chunked` already
    finished writing (its own contract is "Returns True ONLY when every byte
    landed"), so ffprobe always sees a complete, seekable file and reports the
    real total duration rather than a fraction of it — verified directly
    against a real fragmented mp4 (frag_keyframe+empty_moov, matching the DASH
    shape this worker downloads) in
    RealFfmpegValidationTests.test_fully_downloaded_fragmented_source_does_not_false_positive_the_duplicate_ratio.
    """
    info = _probe_media(out_path)
    if not info:
        print(f"[{label}] rejected {video_id}: ffprobe could not read the output", flush=True)
        return None

    codecs = info["codecs"]
    if not codecs or any(codec not in EXPECTED_AUDIO_CODECS for codec in codecs):
        print(f"[{label}] rejected {video_id}: unexpected codec(s) {codecs!r}", flush=True)
        return None

    format_name = (info["format_name"] or "").lower()
    if not any(token in format_name for token in EXPECTED_CONTAINER_TOKENS):
        print(
            f"[{label}] rejected {video_id}: unexpected container {info['format_name']!r}",
            flush=True,
        )
        return None

    duration = info["duration"]
    if duration is None or duration <= 0 or not math.isfinite(duration):
        print(f"[{label}] rejected {video_id}: non-finite duration {duration!r}", flush=True)
        return None

    if raw_path is not None:
        raw_info = _probe_media(raw_path)
        raw_duration = raw_info["duration"] if raw_info else None
        if raw_duration and raw_duration > 0:
            ratio = duration / raw_duration
            low, high = DUPLICATE_DURATION_RATIO
            if low <= ratio <= high:
                print(
                    f"[{label}] rejected {video_id}: duplicated-duration defect "
                    f"({duration:.1f}s output vs {raw_duration:.1f}s source, "
                    f"ratio={ratio:.2f})",
                    flush=True,
                )
                return None

    return CODEC_CONTENT_TYPE.get(codecs[0], "audio/mp4")


def _content_type_sidecar_path(cache_path):
    return cache_path + ".ct"


def _write_content_type(cache_path, content_type):
    """Best-effort: a missing sidecar just falls back to audio/mp4 at serve
    time (see _read_content_type), so a write failure here never blocks the
    track that was just successfully validated and cached."""
    try:
        tmp = _content_type_sidecar_path(cache_path) + f".tmp.{uuid.uuid4().hex}"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(content_type)
        os.replace(tmp, _content_type_sidecar_path(cache_path))
    except OSError:
        pass


def _read_content_type(cache_path):
    try:
        with open(_content_type_sidecar_path(cache_path), encoding="utf-8") as fh:
            value = fh.read().strip()
        return value or "audio/mp4"
    except OSError:
        return "audio/mp4"

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
    or None if any step failed OR the result failed ffprobe validation — the
    caller then fails the track outright (see server.Handler._stream)."""
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
            # `_resolve_stream_url` asks for `bestaudio[ext=m4a]/bestaudio`; when
            # nothing m4a-shaped is available it falls back to whatever bestaudio
            # yt-dlp finds, which is routinely Opus-in-WebM. `-c copy -f mp4` on
            # that source is exactly the ffmpeg-8.0.1 exit-0-with-opus-in-mp4 case
            # this worker's own validation rejects — so every one of those plays
            # used to build a doomed cache entry and fail with a 502 that was
            # anything but exceptional. Probe the raw fetch first: only stream-copy
            # (cheap, ~90ms, no quality loss) when it is CONFIRMED already
            # something this worker can serve. Anything else — including an
            # unreadable probe — transcodes: an ambiguous probe is not evidence
            # the source is safe to copy, and copying a source that turns out
            # to be Opus produces the same unplayable container this validation
            # exists to catch, killing a track a transcode would have saved.
            raw_probe = _probe_media(raw)
            raw_codecs = raw_probe["codecs"] if raw_probe else []
            needs_transcode = (not raw_codecs) or any(
                codec not in EXPECTED_AUDIO_CODECS for codec in raw_codecs
            )
            audio_args = (
                _aac_transcode_args(video_id) if needs_transcode else ["-c", "copy"]
            )
            remux_timeout = (
                _remux_timeout_for(raw_probe["duration"] if raw_probe else None)
                if needs_transcode
                else REMUX_TIMEOUT_S  # a copy remux never gets close to this
            )
            try:
                proc = subprocess.run(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-v", "error",
                        "-y",
                        "-i", raw,
                        "-map", "0:a:0",
                        *audio_args,
                        "-movflags", "+faststart",
                        "-f", "mp4",
                        out,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=remux_timeout,
                )
            except subprocess.TimeoutExpired:
                if needs_transcode:
                    _record_transcode_timeout(video_id)
                print(
                    f"[stream] transcode TIMED OUT for {video_id} after {remux_timeout:.0f}s "
                    f"(needs_transcode={needs_transcode})",
                    flush=True,
                )
                return None
            except subprocess.SubprocessError:
                return None
            if proc.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
                # Loud on purpose: a silent failure here used to fall back to
                # the fragmented upstream. It no longer does — see the module
                # docstring on why that fallback was itself the bug — so a
                # failure here now fails the track outright.
                print(
                    f"[stream] remux failed for {video_id}: "
                    f"rc={proc.returncode} {(proc.stderr or '').strip()[:300]}",
                    flush=True,
                )
                return None
            # `returncode == 0` is not proof of a playable file (ffmpeg 8.0.1
            # exits 0 after muxing Opus into an MP4 container). ffprobe against
            # both the output AND the raw fetch is what actually decides
            # whether this build is safe to serve, including the doubled-
            # duration defect this whole cache exists to eliminate.
            content_type = _validate_audio_output(video_id, out, raw_path=raw, label="stream")
            if content_type is None:
                return None
            os.replace(out, final)
            _write_content_type(final, content_type)
            # A successful build means this video_id is no longer "known
            # slow" — a prior timeout may have been one-off system load, and
            # the NEXT time this track needs a fresh transcode it should get
            # the normal bitrate again, not stay degraded forever.
            _clear_transcode_timeout(video_id)
            # Timings on every build: this path has a latency budget the user can
            # feel (it runs before the first byte of audio), and the throttle it
            # works around is invisible from anywhere else.
            print(
                f"[stream] built {video_id} bytes={os.path.getsize(final)} "
                f"content_type={content_type} "
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

    return _finalize_download_output(video_id, out_path)


def _transcode_to_aac(video_id, src, dst):
    """Re-encode `src` into a validated AAC `.m4a` at `dst`. This is a REAL
    encode, unlike the stream cache's `-c copy` remux: a raw Opus extraction
    cannot simply be rewrapped into an MP4 container and play on iOS, the
    samples themselves must become AAC. Returns True only if the result
    passes `_validate_audio_output` (which also catches the doubled-duration
    defect by comparing against `src`).

    Shares the stream cache's fast-coder default and duration-proportional,
    non-terminal timeout (see the module notes above `REMUX_TIMEOUT_S`): this
    is a background download-queue job rather than something a user is
    watching a spinner for, but the underlying AAC-encoder bottleneck is
    identical, so a fixed timeout here would eventually fail the same way."""
    src_probe = _probe_media(src)
    timeout = _remux_timeout_for(src_probe["duration"] if src_probe else None)
    dst_tmp = f"{dst}.tmp.{uuid.uuid4().hex}"
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-y",
                "-i", src,
                "-map", "0:a:0",
                *_aac_transcode_args(video_id),
                "-movflags", "+faststart",
                "-f", "mp4",
                dst_tmp,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        _record_transcode_timeout(video_id)
        print(
            f"[download] transcode TIMED OUT for {video_id} after {timeout:.0f}s: {exc!r}",
            flush=True,
        )
        try:
            os.remove(dst_tmp)
        except OSError:
            pass
        return False
    except subprocess.SubprocessError as exc:
        print(f"[download] transcode subprocess error for {video_id}: {exc!r}", flush=True)
        try:
            os.remove(dst_tmp)
        except OSError:
            pass
        return False
    if proc.returncode != 0 or not os.path.exists(dst_tmp) or os.path.getsize(dst_tmp) == 0:
        print(
            f"[download] transcode failed for {video_id}: "
            f"rc={proc.returncode} {(proc.stderr or '').strip()[:300]}",
            flush=True,
        )
        try:
            os.remove(dst_tmp)
        except OSError:
            pass
        return False
    content_type = _validate_audio_output(video_id, dst_tmp, raw_path=src, label="download")
    if content_type is None:
        try:
            os.remove(dst_tmp)
        except OSError:
            pass
        return False
    os.replace(dst_tmp, dst)
    _clear_transcode_timeout(video_id)
    return True


def _finalize_download_output(video_id, out_path):
    """Ensure `out_path` holds a validated audio file after yt-dlp's
    postprocessing. Handles yt-dlp landing at a slightly different extension,
    and closes the Opus rename hole: a bare `.opus` extraction is NOT
    re-encoded by a rename, so it goes through a real transcode instead of
    `shutil.move`. Every other candidate is validated the same way the stream
    cache validates its own remux, so `returncode == 0` from yt-dlp is never
    trusted on its own either. Returns (out_path, None) on success or
    (None, error_message) otherwise."""
    if not os.path.exists(out_path):
        # Postprocessing may have produced a slightly different ext — recover it.
        base = out_path[: -len(".m4a")]
        recovered = None
        for ext in (".m4a", ".mp4", ".opus"):
            cand = base + ext
            if os.path.exists(cand):
                recovered = cand
                break
        if recovered is None:
            return None, "download reported success but no output file found"
        if recovered.endswith(".opus"):
            ok = _transcode_to_aac(video_id, recovered, out_path)
            try:
                os.remove(recovered)
            except OSError:
                pass
            if not ok:
                return None, "opus recovery: transcode to AAC failed validation"
            return out_path, None  # _transcode_to_aac already validated the result
        if recovered != out_path:
            shutil.move(recovered, out_path)

    content_type = _validate_audio_output(video_id, out_path, label="download")
    if content_type is None:
        try:
            os.remove(out_path)
        except OSError:
            pass
        return None, "downloaded file failed audio validation"
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


def _radio_store(key, value, ttl=None):
    with _radio_cache_lock:
        # Bounded so a long-lived worker cannot grow this without limit; radios
        # are cheap to rebuild and stale ones are worth less than memory.
        if len(_radio_cache) > 256:
            _radio_cache.clear()
        _radio_cache[key] = (value, time.time() + (RADIO_CACHE_TTL_S if ttl is None else ttl))


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


def recommendations(seed, limit, user_id=None, pure=False):
    """A mixed radio for a seed videoId, personalised for `user_id`.

    Best-effort throughout: every source is allowed to fail on its own and the
    radio is built from whatever answered. A partial radio beats an error.

    `pure=True` restricts the mix to sources that depend on the SEED
    (`_src_seed`, `_src_related`) and drops the three sources that depend only
    on `user_id` (`_src_your_artists`, `_src_your_likes`, `_src_history`).
    This is what a "Porque escuchaste X" row needs: those three are identical
    for every seed the same user has, which was the reported bug — four rows
    sharing the same five tracks, because three of their five sources never
    looked at the seed at all. `_src_history` made it worse, replaying the
    user's own plays — which, for a "because you listened to X" row, includes
    X itself. The default (`pure=False`, every existing caller's implicit
    value) is unchanged: `useAutoplayRadio`'s "Mix para vos" wants exactly
    this personalised blend.
    """
    try:
        yt = _get_ytmusic()
    except Exception:  # noqa: BLE001
        return []

    if not seed:
        seed = _recent_seed_video()

    cache_key = (seed or "", user_id or "", limit, bool(pure))
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

    if pure:
        jobs = {"related": lambda: _src_related(yt, related_id, limit)}
    else:
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

    if pure:
        # Seed-dependent sources only — no user-global filler, and no
        # `_src_history`, since it can literally return the seed track.
        sources = [seed_tracks, gathered.get("related") or []]
    else:
        # History last: it is the weakest signal (you have heard it already)
        # and costs nothing, so it is the natural filler when the network
        # sources come back thin.
        sources = [
            seed_tracks,
            gathered.get("related") or [],
            gathered.get("artists") or [],
            gathered.get("likes") or [],
            _src_history(user_id, limit),
        ]

    results = _interleave(sources, limit)

    if pure:
        # A seeded row must never surface its own seed as a "recommendation".
        if seed:
            results = [row for row in results if row.get("videoId") != seed]
    elif not results:
        # With no seed and nothing personal to go on there is nothing to mix,
        # so fall back to YouTube's own home picks rather than an empty list.
        # NOT done in pure mode: home picks are the same for every seed, which
        # would silently reproduce the exact "every row looks the same" bug
        # this mode exists to fix. An empty pure radio is left empty so the
        # caller (the frontend's generic-feed fallback) can react honestly.
        try:
            results = _home_recommendations(yt, limit)
        except Exception:  # noqa: BLE001
            results = []

    # Cache only a radio worth keeping. Every source is best-effort, so a thin
    # or empty result usually means a transient failure — and the full TTL would
    # turn a blip into ten minutes of a bad rail. Observed on a cold container:
    # get_song_related lost the race, _interleave relaxed the cap to fill the
    # window, and 5-of-12 by one artist was then served identically for the next
    # three requests. A degraded radio still beats no radio, so it is returned;
    # it just is not remembered for long.
    if results:
        worst = 0
        tally = {}
        for row in results:
            artist = (row.get("artist") or "").strip().lower()
            if artist:
                tally[artist] = tally.get(artist, 0) + 1
                worst = max(worst, tally[artist])
        degraded = worst > max(1, int(limit * ARTIST_MAX_SHARE))
        _radio_store(cache_key, results, ttl=60 if degraded else RADIO_CACHE_TTL_S)
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
            content_type = _read_content_type(path)
            return self._serve_open_stream(handle, range_header, content_type)
        finally:
            try:
                handle.close()
            except OSError:
                pass

    def _serve_open_stream(self, handle, range_header, content_type="audio/mp4"):
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
        self.send_header("Content-Type", content_type)
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

        Served EXCLUSIVELY from the validated progressive remux cache (see
        _build_stream_cache) so an iPhone gets a file with exactly one
        declared duration. There is NO fallback to proxying the raw
        fragmented upstream: that fragmented file IS the doubled-duration
        defect (iOS WebKit sums `mvhd` + `elst`), so serving it "because a
        doubled duration beats no audio" had it backwards — a doubled
        duration means `ended` never fires on time, the queue never advances,
        and the WHOLE SESSION hangs instead of just this track. A remux that
        fails to build or fails ffprobe validation now fails the track with
        an explicit error instead, which the client's `onError` already knows
        how to skip past. One skipped track is recoverable; a hung session is
        not."""
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
            # Loud, because a build that always throws would otherwise look
            # like a permanently slow track instead of a failed one.
            print(f"[stream] build raised for {video_id}: {exc!r}", flush=True)
            cached = None
        if cached:
            try:
                os.utime(cached, None)  # LRU touch
            except OSError:
                pass
            if self._serve_cached_stream(cached, range_header):
                return

        # The remux failed (fetch, ffmpeg, or ffprobe validation) or the
        # cached file vanished under a concurrent prune. Fail the track
        # explicitly instead of proxying the fragmented upstream — see the
        # docstring above for why that used to make things worse, not better.
        print(f"[stream] no playable cache for {video_id}, failing the track", flush=True)
        return self._send(502, {"error": "remux_failed", "videoId": video_id})

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
            # Heal any like stored without a title before reading it back, so
            # "Tus me gusta" stops showing bare videoIds. Best-effort and
            # capped; a failure here just leaves the old fallback in place.
            repair_liked_metadata(user_id)
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
            # `pure=1` restricts the mix to seed-dependent sources — used by
            # the frontend's "Porque escuchaste X" rows so that two different
            # seeds for the same user never share their global sources.
            # Defaults to off: every other caller keeps today's personalised
            # blend unchanged.
            pure = (qs.get("pure", ["0"])[0]).strip() in ("1", "true")
            try:
                results = recommendations(seed, limit, user_id, pure=pure)
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
