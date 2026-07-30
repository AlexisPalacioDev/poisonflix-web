# Music Stream Resolution Specification

## Purpose

`STREAM_URL_TTL` (`infra/music-worker/server.py:75`) is `300.0` seconds, far shorter
than the "hours" of real googlevideo URL validity noted in its own code comment,
causing needless mid-session re-resolves. This spec raises the TTL. The worker has no
automated test suite; verification is manual.

**Scope boundary**: this addresses only slow-start/repeat-play latency (S1). It is
explicitly NOT a fix for the 2x duration defect — that root cause (a TTL-boundary
splice) was refuted by controlled experiment (see `exploration.md`, "Post-exploration
correction"). The duration defect is covered exclusively by
`music-playback-diagnostics`.

## Requirements

### Requirement: Extended Stream URL Cache Lifetime

`STREAM_URL_TTL` MUST be raised past real googlevideo URL lifetime (documented as
"hours" in the existing code comment), replacing the current 300.0s value.

#### Scenario: Repeat play within the new TTL avoids re-resolve (manual)

- GIVEN a videoId was resolved and cached by `_resolve_stream_url`
- WHEN a second `/stream` request for the same videoId arrives within the new TTL window (previously outside the old 300s window)
- THEN the worker MUST serve the cached URL without a new `yt-dlp -g` resolve
- Verification: manual — run `docker compose up -d --build music-worker` from `infra/`, issue two timed `/stream` requests for the same videoId spanning >300s but within the new TTL, and confirm the second request's latency does not include a fresh resolve.

#### Scenario: Existing force-refresh path is unaffected

- GIVEN an upstream request against the cached URL fails
- WHEN the existing `force=True` re-resolve path triggers
- THEN it MUST behave exactly as it does today, regardless of the new TTL value

### Requirement: Scope Boundary Is Explicit

The TTL change MUST NOT be documented, communicated, or relied upon anywhere as a fix
for the duration-mismatch defect.

#### Scenario: Duration defect remains open after this change

- GIVEN `STREAM_URL_TTL` has been raised
- WHEN a duration mismatch is later observed
- THEN it MUST still be diagnosed solely through `music-playback-diagnostics` instrumentation, not attributed to or expected to be resolved by this TTL change
