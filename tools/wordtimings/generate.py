#!/usr/bin/env python3
"""Produce real per-word timings for one title, in the client's contract.

Runs on the workstation, never on the media server: reading a full audio
track is the exact load that takes that machine down. The server only ever
serves the file (plain disk I/O).

Two decisions worth knowing:

1. Alignment is per-cue, not per-film. The subtitle already tells us each
   line's time range, so each line is aligned against its own few seconds
   with a small margin. A line that aligns badly cannot poison its
   neighbours, and memory stays flat regardless of runtime.

2. A cue whose alignment looks untrustworthy is OMITTED from the output
   rather than exported with a score. The client treats absence as "fall
   back to the estimate", so there is no confidence threshold to tune on the
   client and no way for a bad cue to be rendered as if it were good.
   This matters because the model's own per-frame score turned out NOT to
   discriminate: it is low almost everywhere, including where the timings
   are demonstrably right.
"""
import argparse
import array
import json
import re
import subprocess
import sys
import time
import wave

import torch
import torchaudio
from torchaudio.functional import forced_align, merge_tokens

SAMPLE_RATE = 16000
MARGIN_S = 0.35

# Sanity bounds for a spoken word. The model emits one frame per 20ms, so a
# short word legitimately lands near that floor - an earlier 40ms cut was
# rejecting real alignments of words like "a" and "I".
MIN_WORD_S = 0.02
MAX_WORD_S = 3.0
# A single odd word does not invalidate a line. Only when a large SHARE of
# the cue looks implausible has the aligner actually lost the thread; before
# that, rejecting the whole cue throws away good timings for its neighbours.
MAX_IMPLAUSIBLE_SHARE = 0.34
# If the aligned words cover far less of the cue than the cue claims, the
# match is suspect even when each individual word looks plausible.
MIN_COVERAGE = 0.35

STAMP = re.compile(
    r"(\d\d):(\d\d):(\d\d)[.,](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[.,](\d\d\d)"
)


def secs(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


class Wav:
    def __init__(self, path):
        self.f = wave.open(path, "rb")
        self.rate = self.f.getframerate()
        self.frames = self.f.getnframes()

    @property
    def duration(self):
        return self.frames / self.rate

    def slice(self, start_s, end_s):
        a = max(0, int(start_s * self.rate))
        b = min(self.frames, int(end_s * self.rate))
        if b <= a:
            return torch.zeros(1, 0)
        self.f.setpos(a)
        samples = array.array("h")
        samples.frombytes(self.f.readframes(b - a))
        return torch.tensor(samples, dtype=torch.float32).unsqueeze(0) / 32768.0


def parse_vtt(path):
    blocks, current = [], []
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\n")
        if not line.strip():
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)

    cues = []
    for block in blocks:
        stamp = next((l for l in block if "-->" in l), None)
        if not stamp:
            continue
        m = STAMP.search(stamp)
        if not m:
            continue
        text = " ".join(block[block.index(stamp) + 1:]).strip()
        text = re.sub(r"<[^>]+>", "", text).strip()
        if text:
            cues.append({
                "start": secs(*m.groups()[:4]),
                "end": secs(*m.groups()[4:]),
                "text": text,
            })
    return cues


def tokenize_words(text, lookup):
    """Split as the CLIENT will split, then normalize for the model.

    The word count has to match what the browser produces from the same cue
    text, because the contract pairs them by position. So the split happens
    on whitespace first, exactly like the client, and normalization only ever
    maps a token to model characters - it never drops or merges tokens.
    """
    raw = text.split()
    out = []
    for word in raw:
        norm = re.sub(r"[^A-Z']", "", word.upper())
        out.append((word, norm))
    return out


def align_cue(model, lookup, wav, cue, total_s):
    pairs = tokenize_words(cue["text"], lookup)
    speakable = [(w, n) for w, n in pairs if n]
    # Every token must be placeable, or positions would shift against the
    # client's own split and the whole cue would highlight the wrong words.
    if not speakable or len(speakable) != len(pairs):
        return None

    a = max(0.0, cue["start"] - MARGIN_S)
    b = min(total_s, cue["end"] + MARGIN_S)
    chunk = wav.slice(a, b)
    if chunk.shape[1] < SAMPLE_RATE // 10:
        return None

    try:
        with torch.inference_mode():
            emission, _ = model(chunk)
            emission = torch.log_softmax(emission, dim=-1)
            tokens = []
            for _, norm in speakable:
                tokens.extend(lookup[c] for c in norm)
                tokens.append(lookup["|"])
            tokens = tokens[:-1]
            aligned, scores = forced_align(
                emission, torch.tensor([tokens], dtype=torch.int32), blank=0
            )
            spans = merge_tokens(aligned[0], scores[0].exp())
    except Exception:  # noqa: BLE001 - one bad cue must not stop the title
        return None

    ratio = chunk.shape[1] / emission.shape[1] / SAMPLE_RATE
    sep = lookup["|"]
    groups, current = [], []
    for span in spans:
        if span.token == sep:
            groups.append(current)
            current = []
        else:
            current.append(span)
    groups.append(current)

    if len(groups) != len(pairs):
        return None

    words = []
    implausible = 0
    for group in groups:
        if not group:
            return None
        ws = a + group[0].start * ratio
        we = a + group[-1].end * ratio
        if not (MIN_WORD_S <= we - ws <= MAX_WORD_S):
            implausible += 1
        words.append((ws, we))

    if implausible / len(words) > MAX_IMPLAUSIBLE_SHARE:
        return None

    for i in range(len(words) - 1):
        if words[i][1] > words[i + 1][0] + 0.001:
            return None

    span_s = words[-1][1] - words[0][0]
    cue_s = max(cue["end"] - cue["start"], 0.001)
    if span_s / cue_s < MIN_COVERAGE:
        return None

    # Offsets are relative to the cue start, in whole milliseconds.
    #
    # Speech routinely begins a moment BEFORE the subtitle's own timestamp -
    # which is why the audio slice carries a margin in the first place - so a
    # negative offset here is the expected case, not a broken alignment.
    # Clamping to the cue start keeps that line usable and costs nothing: the
    # word is simply lit from the instant the line appears. Rejecting those
    # cues (an earlier mistake) discarded most of the film.
    # The same margin that lets a word start early also lets the last one end
    # after the cue does. The client rejects offsets past the cue's own
    # duration, and it is right to: once the line is gone there is nothing on
    # screen left to highlight. Clamp both ends to the line's own span.
    base = cue["start"]
    span_ms = max(1, int(round((cue["end"] - cue["start"]) * 1000)))
    offsets = []
    previous_end = 0
    for ws, we in words:
        s_ms = max(0, min(span_ms - 1, int(round((ws - base) * 1000))))
        e_ms = min(span_ms, int(round((we - base) * 1000)))
        # Rounding to whole milliseconds can collapse a very short word onto
        # a single instant; give it the smallest visible span instead.
        if e_ms <= s_ms:
            e_ms = s_ms + 1
        # Clamping can push a word behind its predecessor; keep the sequence
        # monotonic, since the client walks it in order.
        if s_ms < previous_end:
            s_ms = previous_end
            if e_ms <= s_ms:
                e_ms = s_ms + 1
        offsets.append([s_ms, e_ms])
        previous_end = e_ms
    return offsets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--vtt", required=True)
    ap.add_argument("--item", required=True)
    ap.add_argument("--track", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model()
    lookup = {c: i for i, c in enumerate(bundle.get_labels())}

    wav = Wav(args.wav)
    cues = parse_vtt(args.vtt)
    if args.limit:
        cues = cues[:args.limit]

    started = time.time()
    kept = []
    for i, cue in enumerate(cues):
        offsets = align_cue(model, lookup, wav, cue, wav.duration)
        if offsets:
            kept.append({"t": round(cue["start"], 3), "w": offsets})
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(cues)} cues, {len(kept)} usables", flush=True)

    payload = {"v": 1, "item": args.item, "track": args.track, "cues": kept}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    elapsed = time.time() - started
    pct = 100 * len(kept) / len(cues) if cues else 0
    print(f"\n{len(kept)}/{len(cues)} cues usables ({pct:.0f}%) en {elapsed / 60:.1f} min")
    print(f"escrito {args.out}")


if __name__ == "__main__":
    main()
