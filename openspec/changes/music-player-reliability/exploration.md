# Exploration: music-player-reliability (4 defects)

> **Materialization note**: the exploration agent had no `Write` tool, so this file was
> materialized by `sdd-propose` from Engram observation `#125`
> (topic `sdd/music-player-reliability/explore`, project `poisonflix-web`) to keep the
> hybrid artifact store consistent on disk.

> **CORRECTION — S2 root cause below is REFUTED.** See
> [Post-exploration correction](#post-exploration-correction-s2-refuted) at the end of this
> file. The `STREAM_URL_TTL` splice theory was disproven by a controlled experiment. The
> proposal deliberately does NOT act on it.

## Current State

Music playback runs through: SPA `MusicPlayerProvider.tsx` (single `<audio>` element,
reducer-driven state in `musicPlayerCore.ts`) -> `buildAudioStreamUrl`/`previewStreamUrl`
(`streamResolver.ts`/`musicTrack.ts`) -> BFF -> `infra/music-worker/server.py`
`Handler._stream` (range-proxies a googlevideo URL resolved via `yt-dlp -g`, cached in a
**global, per-videoId** `_stream_cache` with `STREAM_URL_TTL = 300.0`).

## Root causes

### S2 (timer runs past track end, iOS shows 2x duration) — WORKER cause, front-end is a victim

> Superseded — see the correction section.

`server.py:725-763` `_resolve_stream_url` caches the resolved googlevideo URL keyed ONLY by
`video_id`, TTL 300s, shared across ALL sessions. The code comment says googlevideo URLs
"live hours" — the 300s TTL is arbitrarily far shorter than real URL validity and buys no
benefit. `_stream` (line 1463) forwards whatever
`Content-Type/Content-Length/Accept-Ranges/Content-Range` the upstream returns for EACH
request in isolation, with zero validation that a re-resolve mid-session is byte/format
consistent with earlier requests for the same track.

Symptom-4 evidence already measured this session (13,128,732 B in 407.9s ~ 32 KB/s) shows
real playback/buffering sessions commonly exceed the 300s TTL window. Any subsequent Range
request from the `<audio>` element past that boundary gets served against a freshly
re-resolved (not necessarily byte-identical) upstream resource. For a fragmented MP4
(`ftyp, moov, sidx, moof, mdat, moof, mdat...`), splicing two different resolves corrupts
sidx/moof continuity, which is consistent with WebKit computing a corrupted (here: exactly
2x) total duration while the real audio content still ends at ~193s (ffprobe of the
delivered bytes = 193.18s, silencedetect found no trailing silence in that content —
confirming the extra ~193s is phantom/silence generated past the true end, not padding in
the file).

SPA-side `SET_DURATION` (`musicPlayerCore.ts:227-233`) has no doubling logic — it just
accepts any finite positive `duration` from `onLoadedMetadata`/`onDurationChange`, so it
faithfully displays whatever the browser's media engine reports. `playImperative` correctly
seeds duration from `track.durationSeconds` (194s, correct) but that gets overwritten once
the element reports its own duration.

Confidence: strong circumstantial case (code + timing match exactly), but the precise
byte-level mechanism (why exactly 2x) is not proven with a live packet capture — recommend
a repro that captures the Range/Content-Range headers and upstream URL across two
consecutive `/stream` requests spanning the 300s boundary for one videoId before finalizing
the fix design.

Fix candidates: (a) raise `STREAM_URL_TTL` to match real googlevideo URL lifetime (comment
says hours) — e.g. 3600s+ — Low effort, single constant change, removes the spurious
mid-playback re-resolve entirely; (b) pin the resolved URL per playback session instead of a
global TTL cache — Medium effort, more robust but not required if (a) suffices.

### S1 (slow start) — WORKER, partially fixable

`_resolve_stream_url` runs `yt-dlp -g` synchronously in the request thread
(`ThreadingHTTPServer` gives one thread per connection, so this doesn't block other users,
but it does add 2.1-2.3s to the user's own request when uncached). No pre-resolve/pre-warm
path exists today. Low-Medium effort fix: predictive pre-resolve for the next queued track
(the SPA already knows `hasNext`) via a lightweight pre-warm signal to the worker before the
user reaches that track, so the cache is warm by the time `/stream` is actually requested.
Raising the TTL also reduces how often a *repeat* play of the same track pays the 2s cost.

### S4 (stalls / play-pause desync) — SPA, low-medium effort

Confirmed: `MusicPlayerProvider.tsx`'s `<audio>` element (lines 402-465) wires only
`onTimeUpdate`, `onLoadedMetadata`, `onDurationChange`, `onEnded`, `onError`. There is NO
`onWaiting`, `onStalled`, `onPause`, `onPlay`, or `onPlaying` handler anywhere in
`src/features/music/`. `state.isPlaying` is therefore purely optimistic (set by
gesture/reducer) and never corrected by real element playback state — exactly matching the
measured iOS Control Center screenshot (native PLAY icon = actually paused) vs. app UI
(PAUSE icon = `state.isPlaying=true`).

Contributing factor already on record from prior audit: the play/pause effect
(`MusicPlayerProvider.tsx:181-196`) is keyed on `currentItemId`, not `currentSrc`; advancing
to a track with the same itemId loads the new src but never calls `play()` — a second,
independent path to the same paused/state-says-playing desync (not yet fixed; verify still
relevant during propose).

Fix: add `onWaiting`/`onStalled` -> `SET_PLAYING(false)`-equivalent (or a distinct
`buffering` flag) and `onPlaying`/`onPlay` -> reconcile `isPlaying=true`, mirroring the
existing `onError` pattern. Must guard against the belt-and-suspenders unlock effect (lines
203-223), which does a deliberate `play()->pause()` probe on first user interaction — new
handlers must not let that probe flip real playback state.

### S3 (like/dislike missing on mobile) — SPA, low effort, confirmed

`ThumbButtons` renders in the desktop bar at `NowPlayingBar.tsx:307-309` guarded by
`current.videoId`, variant `"bar"`. The mobile `FullPlayer` component
(`NowPlayingBar.tsx:374-537`, the `pf-fullplayer` dialog) has zero `ThumbButtons` in its
transport (lines 470-501) or bottom (503-534) sections. `ThumbButtons` only exposes
`variant?: 'menu' | 'bar'` (`ThumbButtons.tsx:43`) — neither is styled for the full-screen
vertical mobile layout, so the fix needs either a new `'full'` variant + CSS or reuse of
`'bar'` with wrapper CSS; this is a real (small) design decision for sdd-propose, not a
one-line change.

## Affected areas

- `infra/music-worker/server.py` — `_resolve_stream_url` (L725-763), `_stream` (L1463-1513): S1, S2
- `src/features/music/MusicPlayerProvider.tsx` — `<audio>` event handlers (L402-465), play/pause effect keyed on `currentItemId` (L181-196): S2 (duration display, victim not cause), S4
- `src/features/music/musicPlayerCore.ts` — `SET_DURATION` (L227-233): confirmed no doubling bug here, just passthrough
- `src/features/music/NowPlayingBar.tsx` — `FullPlayer` (L374-537): S3
- `src/features/music/ThumbButtons.tsx` — `variant` prop (L43): S3 (needs new variant or CSS)

## Ranking (user impact x fix location)

1. **S2 (2x duration / silent tail)** — highest impact — proposed fix was WORKER-only (TTL constant change). *Refuted, see correction.*
2. **S4 (stalls/desync)** — high impact, frequent on slow connections, causes real playback to silently die while UI claims it's playing — fix is SPA-only (event handler wiring, Low-Medium effort).
3. **S1 (slow start)** — moderate impact (2s delay, once per uncached track) — WORKER-only, Low (TTL) + Medium (pre-warm) effort.
4. **S3 (missing mobile thumbs)** — lowest severity (missing feature, not a reliability break) — SPA-only, Low effort, single file + small CSS addition.

## Recommendation (as written by the exploration agent)

Sequence: S2's TTL fix first (trivial, worker-only, likely also helps S1's repeat-play case)
with a verification repro before commit; then S4's event-handler wiring (SPA-only); S1's
predictive pre-warm as a stretch goal in the same or a follow-up change; S3 as a small
independent SPA slice. All four are small enough to fit comfortably under the 800-line
review budget as a single PR, or can be split worker-fix vs SPA-fix if preferred.

## Risks flagged by exploration

- S2's exact doubling mechanism is inferred from code + timing, not from a captured live repro — include a verification step before treating the fix as proven. **(This risk materialized — see correction.)**
- S4's new media-event handlers must not fight the existing iOS-unlock probe (deliberate `play()->pause()` on first gesture) or the `unlockedRef`/gesture-priority logic already in place.
- The known-but-unfixed `currentItemId` vs `currentSrc` play/pause effect bug and the ENQUEUE-no-dedupe/double-radio-request bug were NOT independently re-verified.
- No `Write` tool was available, so this file could not be written by the exploration agent.

---

## Post-exploration correction (S2 refuted)

The exploration recommended acting on S2 first. A controlled experiment run **after** the
exploration disproved its root cause. The proposal supersedes the exploration on this point.

**Experiment.** The exact bytes the worker delivers for `Trust` (videoId `c4cJIpxpJfI`,
3,128,786 bytes, `ffprobe` duration 193.18s) were served to a real headless Chromium from a
trivial static server, twice:

| Server | Range support | Reported `duration` | Reported `seekable.end(0)` |
|---|---|---|---|
| static, no Range | none | 193.18s | — |
| static, Range-capable (`206` + `Content-Range: bytes S-E/TOTAL`, mimicking the worker) | full | 193.18s | 193.18 |

**Corroborating evidence.** A 13,128,732-byte track was downloaded in a single linear read
taking 407.9s — crossing the 300s TTL boundary — and returned the exact expected byte count.

**Conclusions.**

1. The delivered file is correct.
2. Standard `206`/`Content-Range` serving of that file is correct.
3. Chromium does not double the duration under either serving mode.
4. Crossing the TTL boundary mid-transfer does not corrupt or truncate the byte stream.

Therefore the fragmented-MP4 splice theory is not supported. **The 2x duration is
iOS-WebKit-specific and its mechanism is NOT yet identified.** No speculative behavioural
fix should be proposed for it; the proposal scopes instrumentation only.

`STREAM_URL_TTL` still gets raised in this change, but under S1 (avoid needless re-resolves
on repeat plays), not as an S2 fix.
