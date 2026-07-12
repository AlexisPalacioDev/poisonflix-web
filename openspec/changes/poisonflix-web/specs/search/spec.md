# Search Specification

## Purpose

Defines debounced, deduplicated TMDB search with a unified library-status badge, ported from `SearchViewModel.kt` and `LibraryIndex.kt`.

## Requirements

### Requirement: Debounced query with minimum length

The system MUST debounce search input by 350ms and MUST NOT issue a request while the settled query is shorter than 2 characters (`SearchViewModel.kt` L106-119, L238).

#### Scenario: Below minimum length

- GIVEN the user types a single character
- WHEN 350ms of quiet elapses
- THEN no search request is issued

#### Scenario: Rapid retyping resets the timer

- GIVEN the user is typing continuously
- WHEN each keystroke arrives before 350ms of quiet has elapsed
- THEN the debounce timer resets each time and only the final settled query fires a request

#### Scenario: Settles and fires once

- GIVEN the user types a 2+ character query and stops
- WHEN 350ms of quiet elapses
- THEN exactly one search request is issued for the settled query

### Requirement: Deduplicated results in a carousel with preview

The system MUST deduplicate TMDB results by id (`distinctBy(id)`, `SearchRepositoryImpl.kt` L23) and MUST present them as a carousel with a large preview panel for the selected item.

#### Scenario: Duplicate TMDB ids collapse to one

- GIVEN the raw search response contains the same TMDB id twice
- WHEN results are processed
- THEN only one entry for that id appears in the carousel

#### Scenario: Selecting a result shows its preview

- GIVEN search results are rendered as a carousel
- WHEN the user selects an item
- THEN a big preview panel renders that item's detail

### Requirement: Unified library-status badge

The system MUST attach one of `InLibrary | Requesting | Requestable` to each result via `LibraryIndex`, matching primarily on Jellyfin `ProviderIds.Tmdb`, falling back to title+year when no TMDB id is present on the library item (`LibraryIndex.kt` L23-30, L40-63, L49-52).

#### Scenario: InLibrary via primary TMDB-id match

- GIVEN a Jellyfin library item has `ProviderIds.Tmdb` equal to the result's TMDB id
- WHEN the badge is computed
- THEN the result is marked `InLibrary`

#### Scenario: InLibrary via fallback title+year match

- GIVEN a Jellyfin library item lacks a TMDB id but its title and year match the result
- WHEN the badge is computed
- THEN the result is marked `InLibrary` via the fallback match

#### Scenario: Requesting

- GIVEN neither library match applies, but an active Jellyseerr request exists for the result's TMDB id
- WHEN the badge is computed
- THEN the result is marked `Requesting`

#### Scenario: Requestable

- GIVEN neither a library match nor an active request exists
- WHEN the badge is computed
- THEN the result is marked `Requestable`

## Deferred

- TV/series search results and the two-pane season/episode detail.
- AniList-sourced adult metadata filtering.
