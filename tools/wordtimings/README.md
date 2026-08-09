# Word timings

Offline forced alignment: produces the per-word timings the player uses to
highlight the English subtitle as it is spoken. Without these files the player
falls back to an estimate, so this is an enhancement, never a dependency.

## Run it on a workstation, never on the media server

Reading a full audio track is the exact load that takes mendezserver down. The
server is only ever asked for the file itself, which is plain disk I/O.

```bash
# 1. audio + subtitle (ask the server for the file, decode locally)
curl -H @headers "http://192.168.1.50:8096/Videos/$ID/stream.mp4?static=true&mediaSourceId=$ID" -o film.mp4
ffmpeg -i film.mp4 -vn -ac 1 -ar 16000 audio.wav
curl -H @headers "http://192.168.1.50:8096/Videos/$ID/$ID/Subtitles/$TRACK/Stream.vtt" -o en.vtt

# 2. align (needs torch + torchaudio; a python:3.12-slim container is enough,
#    the system python is too new for the wheels)
python3 generate.py --wav audio.wav --vtt en.vtt --item "$ID" --track "$TRACK" --out "$ID.json"

# 3. publish - Caddy already serves this directory, no config change needed
scp "$ID.json" mendez@mendezserver:~/poisonflix-workspace/poisonflix-web/infra/updates/wordtimings/
```

## Numbers, measured

- ~20 min per feature film on 16 CPU cores, no GPU.
- ~86% of cues survive the plausibility checks; the rest are omitted on purpose.
- ~100ms median error against the real word boundary, versus ~310ms for the
  estimate. Verified by agreement with a second, independent model (MMS_FA):
  two systems that share no code landing on the same number is the strongest
  evidence available without hand-labelling audio.
- ~70KB of JSON per film.

## Two decisions worth keeping

**Per-cue, not per-film.** The subtitle already tells us each line's time
range, so each line aligns against its own few seconds. A line that aligns
badly cannot poison its neighbours, and memory stays flat.

**A doubtful cue is omitted, not exported with a score.** The client reads
absence as "use the estimate". This is deliberate: the model's own per-frame
confidence turned out NOT to discriminate - it is low nearly everywhere,
including where the timings are demonstrably right - so a threshold on it
would have been worse than useless.

## The trap that cost the most time

Offsets are relative to the cue start and must stay inside the cue's own
duration. Speech routinely begins before the subtitle appears and ends after
it disappears, which is why the audio slice carries a margin - but exporting
those out-of-range offsets makes the client reject the cue (correctly: once
the line is gone there is nothing to highlight). Both ends are clamped. An
earlier version rejected such cues outright instead and shipped 10% coverage
where 86% was available.
