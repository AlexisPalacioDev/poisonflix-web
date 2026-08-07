#!/usr/bin/env python3
"""Library maintenance: verify and repair fragmented/invalid audio files
already sitting on disk in MUSIC_DIR.

EXPERIMENTAL / not part of the deployed worker: this file is NOT copied into
the Docker image (see Dockerfile) and is not wired into server.py's request
handling. It is a manual, run-by-hand maintenance script only. The library it
targets is not even reachable from this stack in the current compose setup
(`${DATA_DIR}/media` resolves to an empty variable, so MUSIC_DIR mounts the
host's bare `/media`), so this has not been exercised against a real library.
Treat everything below as unproven until someone runs it by hand and reads
the output.

  --verify-hypothesis [--sample N]
      Cheap and non-destructive. Samples N already-downloaded files and
      reports how many are fragmented MP4.

  --repair [--concurrency N] [--limit N] [--write]
      Walks the library and reports which files ffprobe validation would
      reject. **Defaults to a dry run: nothing is re-encoded, replaced, or
      deleted unless `--write` is also passed.** Pass `--write` only after
      reading the dry-run report — re-encoding is destructive (it replaces
      the file in place) and has not been validated against a real library.

Reuses server.py's ffprobe validation (_probe_media, _validate_audio_output,
EXPECTED_AUDIO_CODECS) so "what counts as broken" is defined in exactly one
place, not duplicated between the hot path and this maintenance tool.
"""

import argparse
import concurrent.futures
import json
import os
import random
import subprocess
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402  (needs the sys.path fix-up above)

AUDIO_EXTENSIONS = (".m4a", ".mp4", ".mp3")
REPAIR_STATE_PATH = os.path.join(server.DATA_DIR, "media_repair_state.json")

# ffprobe has no "is this fragmented" boolean -- a fragmented file can report
# a perfectly sane codec, container and duration. What it CANNOT do is avoid
# these two boxes: `mvex` (movie extends -- declares the file supports
# fragments) and `moof` (an actual movie fragment). A plain progressive MP4
# produced with `-movflags +faststart` has neither. Both sit near the top of
# a real-world file, so reading a few MB is enough without pulling in a new
# dependency.
_FRAGMENTED_MP4_MARKERS = (b"moof", b"mvex")
_FRAGMENTATION_SCAN_BYTES = 4 * 1024 * 1024


def iter_audio_files(music_dir):
    for root, _dirs, files in os.walk(music_dir):
        for name in files:
            if name.lower().endswith(AUDIO_EXTENSIONS):
                yield os.path.join(root, name)


def is_fragmented_mp4(path):
    """True/False, or None if the file could not be read at all."""
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(_FRAGMENTATION_SCAN_BYTES)
    except OSError:
        return None
    return any(marker in chunk for marker in _FRAGMENTED_MP4_MARKERS)


def needs_repair(path):
    """Returns (bad: bool, reason: str|None). A file needs repair if ffprobe
    validation rejects it OR it is fragmented -- server._validate_audio_output
    alone cannot see fragmentation, since a fragmented file can still report a
    perfectly sane duration to ffprobe."""
    info = server._probe_media(path)
    if not info:
        return True, "unreadable by ffprobe"
    codecs = info["codecs"]
    if not codecs or any(c not in server.EXPECTED_AUDIO_CODECS for c in codecs):
        return True, f"unexpected codec(s) {codecs!r}"
    if is_fragmented_mp4(path):
        return True, "fragmented MP4 (moof/mvex present)"
    return False, None


def sample_fragmentation_report(music_dir, sample_size=50, seed=None):
    """Task-3-style cheap verification: sample instead of scanning everything,
    and answer with a count before any repair work is justified."""
    all_files = list(iter_audio_files(music_dir))
    rng = random.Random(seed)
    sample = all_files if len(all_files) <= sample_size else rng.sample(all_files, sample_size)
    fragmented = []
    unreadable = []
    for path in sample:
        frag = is_fragmented_mp4(path)
        if frag is None:
            unreadable.append(path)
        elif frag:
            fragmented.append(path)
    return {
        "library_total": len(all_files),
        "sampled": len(sample),
        "fragmented": len(fragmented),
        "unreadable": len(unreadable),
        "fragmented_paths": fragmented,
    }


def _cleanup(tmp_path):
    try:
        os.remove(tmp_path)
    except OSError:
        pass


def repair_file(path):
    """Re-encode ONE defective file in place. Always a real AAC encode (never
    `-c copy`) -- that fixes a wrong codec AND fragmentation in a single pass
    -- and it is validated the same way server._transcode_to_aac validates a
    download before it is allowed to replace the original.

    Returns (ok: bool, error: str|None).
    """
    tmp = f"{path}.repair.{os.getpid()}.{threading.get_ident()}.m4a"
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-y",
                "-i", path,
                "-map", "0:a:0",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                "-f", "mp4",
                tmp,
            ],
            capture_output=True,
            text=True,
            timeout=server.REMUX_TIMEOUT_S,
        )
    except subprocess.SubprocessError as exc:
        _cleanup(tmp)
        return False, f"ffmpeg subprocess error: {exc!r}"
    if proc.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
        _cleanup(tmp)
        return False, f"ffmpeg exit {proc.returncode}: {(proc.stderr or '').strip()[:300]}"
    content_type = server._validate_audio_output(
        os.path.basename(path), tmp, raw_path=path, label="repair"
    )
    if content_type is None:
        _cleanup(tmp)
        return False, "repaired output failed validation"
    if is_fragmented_mp4(tmp):
        # Belt-and-braces: _validate_audio_output cannot see fragmentation
        # (see needs_repair's docstring), so re-check the thing this whole
        # tool exists to fix before ever trusting the result.
        _cleanup(tmp)
        return False, "repaired output is STILL fragmented"
    os.replace(tmp, path)
    return True, None


class RepairState:
    """Resumable progress: one JSON file mapping path -> "ok" | "fixed" |
    "failed:<reason>". Written after EVERY completed file, not batched, so a
    killed process loses at most the file in flight, never the ones already
    recorded."""

    def __init__(self, state_path):
        self.state_path = state_path
        self._lock = threading.Lock()
        self.data = self._load()

    def _load(self):
        try:
            with open(self.state_path, encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, ValueError, OSError):
            return {}

    def is_done(self, path):
        return path in self.data

    def mark(self, path, status):
        with self._lock:
            self.data[path] = status
            try:
                os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
                tmp = self.state_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(self.data, fh)
                os.replace(tmp, self.state_path)
            except OSError:
                pass  # best-effort persistence; a lost write only costs a re-scan


def run_repair(music_dir, concurrency=2, limit=None, state_path=REPAIR_STATE_PATH, write=False):
    """Batches the library into (a) already-known-good files, skipped, (b) new
    files confirmed good this run, marked and skipped, and (c) defective
    files, bounded by `concurrency` workers and optionally by `limit` (so a
    single invocation never touches the whole library at once).

    `write` defaults to False: defective files are only REPORTED (path +
    reason), never sent to `repair_file`, and no state is recorded for them —
    a dry run must be fully safe to run against a real library with zero
    knowledge of what is in it. Pass `write=True` (the CLI's `--write` flag)
    to actually re-encode."""
    state = RepairState(state_path)
    candidates = []
    for path in iter_audio_files(music_dir):
        if state.is_done(path):
            continue
        bad, reason = needs_repair(path)
        if not bad:
            state.mark(path, "ok")
            continue
        candidates.append((path, reason))
        if limit and len(candidates) >= limit:
            break

    if not write:
        return {
            "dry_run": True,
            "candidates": len(candidates),
            "would_repair": [{"path": p, "reason": r} for p, r in candidates],
        }

    results = {"dry_run": False, "repaired": 0, "failed": 0, "candidates": len(candidates)}

    def _work(item):
        path, _reason = item
        ok, err = repair_file(path)
        state.mark(path, "fixed" if ok else f"failed:{err}")
        return ok

    if candidates:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            for ok in pool.map(_work, candidates):
                results["repaired" if ok else "failed"] += 1

    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-hypothesis",
        action="store_true",
        help="Sample the library and report how many files are fragmented MP4.",
    )
    parser.add_argument("--sample", type=int, default=50)
    parser.add_argument(
        "--repair",
        action="store_true",
        help="Report defective files. Dry run by default — see --write.",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Combined with --repair: actually re-encode defective files in place. "
        "Without this, --repair only reports what it would do.",
    )
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--music-dir", default=server.MUSIC_DIR)
    args = parser.parse_args()

    if args.verify_hypothesis:
        print(json.dumps(sample_fragmentation_report(args.music_dir, args.sample), indent=2))
        return
    if args.repair:
        print(
            json.dumps(
                run_repair(
                    args.music_dir,
                    concurrency=args.concurrency,
                    limit=args.limit,
                    write=args.write,
                ),
                indent=2,
            )
        )
        return
    parser.print_help()


if __name__ == "__main__":
    main()
