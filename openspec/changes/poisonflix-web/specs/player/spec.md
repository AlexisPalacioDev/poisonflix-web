# Player Specification

## Purpose

Defines DirectPlay-only `<video>` playback: stream resolution, the `<video>` authentication strategy (the MVP's primary live-validation target), resume seek, and the Jellyfin playback heartbeat. Ported from `StreamResolver.kt` and `PlaybackController.kt`.

## Requirements

### Requirement: DirectPlay-only stream resolution

The system MUST resolve `PlaybackInfo` to a DirectPlay `<video>` src (`Videos/{itemId}/stream{ext}?static=true&mediaSourceId=...`, `StreamResolver.kt` L196-200) when no `TranscodingUrl` is present, and MUST render an explicit "not supported in this version" state — without attempting playback — when a `TranscodingUrl` is present.

#### Scenario: No TranscodingUrl — DirectPlay

- GIVEN `PlaybackInfo` for an item contains no `TranscodingUrl`
- WHEN the player resolves the stream
- THEN a DirectPlay URL is built and set as the `<video>` element's `src`

#### Scenario: TranscodingUrl present — explicit unsupported state

- GIVEN `PlaybackInfo` for an item contains a `TranscodingUrl`
- WHEN the player resolves the stream
- THEN an explicit "not supported in this version" state is rendered and no playback is attempted

### Requirement: Authenticated `<video>` stream (primary live-validation target)

The system MUST authenticate the DirectPlay `<video>` request without relying on a custom header, since `<video>` cannot send `X-Emby-Token`. The MVP strategy is to append the Jellyfin token as an `api_key` query-string parameter on the stream URL; this behavior MUST be verified live against the real backend before dependent playback features are built.

#### Scenario: `api_key` query-string authenticates the stream

- GIVEN a DirectPlay URL built with `api_key={token}` in the query string
- WHEN the `<video>` element requests the stream
- THEN the backend accepts the request and streams the video without a 401, preserving range-request seeking

#### Scenario: Authentication rejected surfaces an explicit error

- GIVEN the stream request is rejected by the backend (e.g. 401)
- WHEN the rejection occurs
- THEN the player surfaces an explicit error state rather than failing silently

### Requirement: Resume seek on ready

The system MUST seek the `<video>` element to the resume position (converted from `resumePositionTicks` to seconds) on the `canplay`/`loadedmetadata` event, only when that position is greater than zero (`PlaybackController.kt` L96-104, L179-182).

#### Scenario: Resume position present

- GIVEN `resumePositionTicks` is greater than zero
- WHEN the `canplay`/`loadedmetadata` event fires
- THEN the player seeks to the converted resume position

#### Scenario: No resume position

- GIVEN `resumePositionTicks` is zero
- WHEN the `canplay`/`loadedmetadata` event fires
- THEN no seek is applied and playback starts from the beginning

### Requirement: Playback progress heartbeat

The system MUST report `Sessions/Playing` once at playback start, `Sessions/Progress` on a recurring ~10s cadence while playing, and `Sessions/Stopped` on pause, unmount, or navigation away, clearing the interval so no orphaned reports are sent (`JellyfinApi.kt` L102-109).

#### Scenario: Playing reported on start

- GIVEN the video begins playing
- WHEN playback starts
- THEN `Sessions/Playing` is reported exactly once

#### Scenario: Progress and Stopped reported correctly

- GIVEN the video is playing
- WHEN ~10s elapses
- THEN `Sessions/Progress` is reported
- AND WHEN the user pauses, unmounts the player, or navigates away
- THEN `Sessions/Stopped` is reported and the progress interval is cleared

## Deferred

- HLS transcode playback via hls.js, and audio/subtitle track switching.
- Resume-seek-after-ready re-verification under hls.js (`PlaybackController.kt` L96-104, L199-205 design note).
- Subtitle `Format.id` prefix-match handling under HLS (`PlaybackController.kt` L265-275 design note).
- `Blob + createObjectURL` fallback strategy if the `api_key` query-string approach is rejected live.
