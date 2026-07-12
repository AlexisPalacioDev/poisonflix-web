# Detail + Request Specification

## Purpose

Defines the movie detail screen's context-aware request action and the Jellyseerr request flow, ported from `DetailRepositoryImpl.requestMedia` (L120-134) and the `LibraryIndex` status badge shared with Search.

## Requirements

### Requirement: Context-aware "Pedir" action visibility

The system MUST show the "Pedir" (request) action only for items whose status badge is `Requestable`, and MUST NOT show it for `InLibrary` items.

#### Scenario: InLibrary item hides the action

- GIVEN a detail item's status badge is `InLibrary`
- WHEN the detail screen renders
- THEN no "Pedir" action is shown

#### Scenario: Requestable item shows the action

- GIVEN a detail item's status badge is `Requestable`
- WHEN the detail screen renders
- THEN the "Pedir" action is shown and enabled

#### Scenario: Requesting item disables/hides the action

- GIVEN a detail item's status badge is `Requesting`
- WHEN the detail screen renders
- THEN the "Pedir" action is hidden or disabled to prevent a duplicate request

### Requirement: Request submission to Jellyseerr

The system MUST submit a request via `POST api/v1/request` with `{mediaType: 'movie', mediaId}` when the user activates "Pedir" (`DetailRepositoryImpl.requestMedia` L120-134).

#### Scenario: User submits a request

- GIVEN a `Requestable` movie detail
- WHEN the user taps "Pedir"
- THEN a `POST` request fires with the movie's TMDB id and `mediaType: 'movie'`

### Requirement: Status reflects server response, no optimistic update

The system MUST update the displayed status from `response.media.status` after a successful request, and MUST NOT optimistically flip the status before the server confirms; on request failure the status MUST remain unchanged.

#### Scenario: Successful request updates status from the response

- GIVEN the request POST succeeds
- WHEN the response arrives
- THEN the displayed status is set from `response.media.status`, not from an assumed local value

#### Scenario: Failed request leaves status unchanged

- GIVEN the request POST fails (network or API error)
- WHEN the failure is received
- THEN the status remains `Requestable` and no optimistic "Requesting" state is shown

## Deferred

- TV/series requests and two-pane season/episode selection.
- Delete/cancel-download flows against the *arr stack.
