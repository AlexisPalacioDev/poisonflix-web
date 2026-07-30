# Music Track Feedback Specification

## Purpose

Like/dislike parity: `ThumbButtons` today only supports `'menu'` and `'bar'` variants
and is absent from the mobile full-screen `FullPlayer`. This spec adds a `'full'`
variant and wires it into `FullPlayer`, without altering desktop behavior.

## Requirements

### Requirement: Full Variant Support

`ThumbButtonsProps.variant` MUST accept `'full'` in addition to the existing
`'menu' | 'bar'`, rendering both thumb-up and thumb-down controls.

#### Scenario: Full variant renders both controls

- GIVEN `ThumbButtons` is rendered with `variant="full"` and a `videoId`
- WHEN the component mounts
- THEN both the thumb-up and thumb-down buttons MUST be present and interactive

#### Scenario: Full variant is visually distinct

- GIVEN `ThumbButtons` is rendered with `variant="full"`
- WHEN the root element's class list is inspected
- THEN it MUST include a `full`-scoped class distinct from `menu` and `bar` classes

### Requirement: Mobile Full Player Rendering

`FullPlayer` (`NowPlayingBar.tsx:374-537`) MUST render `ThumbButtons` with
`variant="full"`, guarded by `current.videoId` — mirroring the existing desktop bar
guard at `NowPlayingBar.tsx:307-309`.

#### Scenario: Renders when the current track has a videoId

- GIVEN `current.videoId` is defined in `FullPlayer`
- WHEN `FullPlayer` renders
- THEN `ThumbButtons` with `variant="full"` MUST be present in the output

#### Scenario: Does not render for an unmatched library track

- GIVEN `current.videoId` is undefined (a library track never matched to a videoId)
- WHEN `FullPlayer` renders
- THEN `ThumbButtons` MUST NOT render, matching the desktop bar's existing guard behavior

#### Scenario: Rating action reaches the same store as the desktop bar

- GIVEN `ThumbButtons` with `variant="full"` is rendered for a track with a `videoId`
- WHEN the user presses thumb-up
- THEN the rating MUST be persisted through the same `useRatings().rate` call used by the `'bar'` and `'menu'` variants
