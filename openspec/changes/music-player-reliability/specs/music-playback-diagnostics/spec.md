# Music Playback Diagnostics Specification

## Purpose

Diagnostic-only telemetry for the unidentified iOS duration-mismatch defect (measured:
386s shown vs. 193.18s ffprobe-measured, exactly 2x; refuted as a `STREAM_URL_TTL`
splice — see `exploration.md` correction). This spec covers instrumentation ONLY. It
MUST NOT introduce any corrective playback behavior.

## Requirements

### Requirement: Duration Mismatch Reporting

When the `<audio>` element's `duration` disagrees with the track's declared
`durationSeconds` beyond a tolerance, the system MUST call `reportFailure(scope, cause,
detail)` (`src/lib/obs/report.ts`) with `detail` carrying: `duration`, `seekable.end`,
`buffered.end`, `currentTime`, `readyState`, the declared `durationSeconds`, and the
`videoId`.

#### Scenario: Mismatch reported on durationchange

- GIVEN a track with declared `durationSeconds` of 193.18
- WHEN the element emits `durationchange` reporting `duration` of 386 (beyond tolerance)
- THEN `reportFailure` MUST be called once with a detail payload containing all seven required fields

#### Scenario: Mismatch reported on ended

- GIVEN a track with declared `durationSeconds` of 193.18
- WHEN the element emits `ended` while `duration` still disagrees beyond tolerance
- THEN `reportFailure` MUST be called with the same required detail fields

#### Scenario: Agreement within tolerance does not report

- GIVEN the element's `duration` is within tolerance of the declared `durationSeconds`
- WHEN `durationchange` or `ended` fires
- THEN `reportFailure` MUST NOT be called for a duration mismatch

### Requirement: No Corrective Behavior

The system MUST NOT alter duration display, seek position, playback state, or
`currentSrc` as a result of detecting a mismatch. This requirement codifies a
non-goal: no behavioral fix ships until the mismatch mechanism is identified.

#### Scenario: Diagnostic firing does not change playback

- GIVEN a duration mismatch is detected and reported
- WHEN the report completes
- THEN `state.isPlaying`, `state.buffering`, `currentTime`, and `currentSrc` MUST be identical to their pre-report values

#### Scenario: Reporting never throws

- GIVEN `reportFailure` is called for a mismatch
- WHEN the call executes
- THEN it MUST NOT throw, per the existing `reportFailure` contract, so playback is never interrupted by the diagnostic itself
