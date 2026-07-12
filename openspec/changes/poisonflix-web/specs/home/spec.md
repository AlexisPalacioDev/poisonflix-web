# Home Specification

## Purpose

Defines the MVP Home screen row set and the row-isolation guarantee ported from `HomeViewModel.kt`: each row is an independent query so one failing row never takes down the rest of the screen.

## Requirements

### Requirement: Fixed MVP row set

The system MUST render exactly two rows for the MVP: a Library row (Jellyfin `Users/{userId}/Items`) and a Trending row (Jellyseerr `discover/trending`).

#### Scenario: Both rows load successfully

- GIVEN an authenticated session
- WHEN Home mounts
- THEN the Library row and the Trending row each render their own items independently

### Requirement: Row isolation

The system MUST isolate each row's loading/error/retry state so a failure in one row MUST NOT blank or block any other row (mirrors `HomeViewModel.kt`'s independent `Result<T>` rows).

#### Scenario: Trending row fails, Library unaffected

- GIVEN the Jellyseerr trending request fails
- WHEN Home renders
- THEN the Trending row shows a row-scoped error/retry state while the Library row still renders its items

#### Scenario: Library row fails, Trending unaffected

- GIVEN the Jellyfin items request fails
- WHEN Home renders
- THEN the Library row shows a row-scoped error/retry state while the Trending row still renders its items

## Deferred

- Continue Watching row, polled every 20s (`HomeViewModel.kt` L172-184).
- Downloading row, polled every 15s (`HomeViewModel.kt` L154-171).
- 10 genre/category rows (`domain/model/Category.kt` L30-41).
- +18 PIN gate overlay (`ui/home/AdultPinOverlay.kt`, `HomeViewModel.kt` L84-90).
