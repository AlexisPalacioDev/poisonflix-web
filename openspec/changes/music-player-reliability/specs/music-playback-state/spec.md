# Music Playback State Specification

## Purpose

The `<audio>` element, not the reducer's optimistic flag, is the source of truth for
whether audio is playing. This spec defines how `state.isPlaying` and a new
`state.buffering` flag are reconciled from real media events in
`MusicPlayerProvider.tsx`, and how the deliberate iOS unlock probe is excluded from
that reconciliation.

## Requirements

### Requirement: Playing State Reconciliation From Media Events

`state.isPlaying` MUST be reconciled from the `<audio>` element's `play`, `playing`,
and `pause` events, not left purely optimistic from reducer-issued PLAY/PAUSE actions.

#### Scenario: External pause reconciles state

- GIVEN a track is loaded and `state.isPlaying` is `true`
- WHEN the audio element emits a `pause` event not caused by the unlock probe
- THEN `state.isPlaying` MUST become `false`

#### Scenario: Playing event confirms play

- GIVEN a track is loaded and `state.isPlaying` is `false`
- WHEN the audio element emits `play` or `playing`
- THEN `state.isPlaying` MUST become `true`

### Requirement: Unlock Probe Suppression

The deliberate `play()` → `pause()` unlock probe (`MusicPlayerProvider.tsx:203-223`,
guarded by `unlockedRef`) MUST NOT be observable by consumers as a user-visible pause.
Reconciliation from Playing State Reconciliation MUST be suppressed for the probe's
own `pause` event.

#### Scenario: Probe does not flip real state

- GIVEN a track is loaded, paused, and the unlock probe fires on first user gesture
- WHEN the probe calls `audio.play()` then `audio.pause()`
- THEN `state.isPlaying` MUST remain unchanged as a direct result of the probe's own events

#### Scenario: Probe still marks the element unlocked

- GIVEN the unlock probe completes
- THEN `unlockedRef.current` MUST be `true` afterward, independent of reconciliation suppression

### Requirement: Buffering Distinct From Paused

A stall (`waiting`/`stalled`) MUST surface as `state.buffering`, and MUST NOT set
`state.isPlaying` to `false`.

#### Scenario: Stall does not report as paused

- GIVEN `state.isPlaying` is `true`
- WHEN the audio element emits `waiting` or `stalled`
- THEN `state.isPlaying` MUST remain `true` AND `state.buffering` MUST become `true`

#### Scenario: Resuming playback clears buffering

- GIVEN `state.buffering` is `true`
- WHEN the audio element emits `playing`
- THEN `state.buffering` MUST become `false`

### Requirement: Buffering Settle Window

Transient `waiting`/`stalled` blips MUST NOT visibly flap the buffering indicator,
given measured throughput (~32 KB/s on a 129 kbps stream) makes brief underruns
expected rather than exceptional.

#### Scenario: Short blip does not surface

- GIVEN a settle window of 250ms (assumption, see risks)
- WHEN `waiting` fires and `playing` follows within that window
- THEN `state.buffering` MUST NOT have transitioned to `true` at any point observable by subscribers

#### Scenario: Sustained stall does surface

- GIVEN the settle window has elapsed
- WHEN `waiting` or `stalled` is still the last-seen state
- THEN `state.buffering` MUST become `true`

## Out of Scope

Reconciliation MUST NOT touch the `currentItemId`-vs-`currentSrc` play/pause effect key
(`MusicPlayerProvider.tsx:181-196`) or attempt stream-throughput mitigation — both are
tracked separately and excluded from this change.
