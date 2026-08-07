#!/usr/bin/env python3
"""Library maintenance: DIAGNOSTIC ONLY. Reports fragmented/invalid audio
files already sitting on disk in MUSIC_DIR. Cannot modify, re-encode, or
delete anything — there is no code path in this file that writes to a file
under MUSIC_DIR or anywhere else.

EXPERIMENTAL / not part of the deployed worker: this file is NOT copied into
the Docker image (see Dockerfile) and is not wired into server.py's request
handling. It is a manual, run-by-hand maintenance script only. The library it
targets is not even reachable from this stack in the current compose setup
(`${DATA_DIR}/media` resolves to an empty variable, so MUSIC_DIR mounts the
host's bare `/media`), so this has not been exercised against a real library.
Treat everything below as unproven until someone runs it by hand and reads
the output.

  --verify-hypothesis [--sample N]
      Samples N already-downloaded files and reports how many are
      fragmented MP4.

  --repair [--limit N]
      Walks the library and reports which files ffprobe validation would
      reject. Report only — no re-encode, no replace, no state file.

An earlier version of this tool had a real `--write` repair path. An audit
found it (1) re-encoded with `-map 0:a:0`, silently dropping embedded cover
art, and (2) replaced the original with `os.replace` and no backup — a bug in
either step meant an unrecoverable, format-degraded music library with no way
back. Per the audit's own suggested simplification, that path has been
removed entirely rather than patched: there is currently no way to make this
tool write anything. Re-introduce write support only alongside cover-art
preservation and a real backup-before-replace step, with its own tests
proving both.

Reuses server.py's ffprobe validation (_probe_media, EXPECTED_AUDIO_CODECS) so
"what counts as broken" is defined in exactly one place, not duplicated
between the hot path and this maintenance tool.
"""

import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402  (needs the sys.path fix-up above)

AUDIO_EXTENSIONS = (".m4a", ".mp4", ".mp3")

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


def run_repair(music_dir, limit=None):
    """Scans the library and reports which files ffprobe validation would
    reject. Pure report: no re-encode, no replace, no state file, no
    concurrency — nothing here writes anything anywhere. `limit` bounds how
    many defective files are collected before the scan stops early (so a
    single invocation never has to walk the entire library just to answer
    "are there any")."""
    candidates = []
    for path in iter_audio_files(music_dir):
        bad, reason = needs_repair(path)
        if bad:
            candidates.append({"path": path, "reason": reason})
            if limit and len(candidates) >= limit:
                break
    return {"candidates": len(candidates), "would_repair": candidates}


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
        help="Report defective files. Diagnostic only — cannot write anything.",
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--music-dir", default=server.MUSIC_DIR)
    args = parser.parse_args()

    if args.verify_hypothesis:
        print(json.dumps(sample_fragmentation_report(args.music_dir, args.sample), indent=2))
        return
    if args.repair:
        print(json.dumps(run_repair(args.music_dir, limit=args.limit), indent=2))
        return
    parser.print_help()


if __name__ == "__main__":
    main()
