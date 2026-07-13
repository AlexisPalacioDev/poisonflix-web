# Detail + Request Specification — DELTA (TV support)

## Purpose

Delta over the `poisonflix-web` change's movie-only `detail-request` spec: extends the detail screen and request flow to TV series so the availability preview (and the request action) work for both media types. Movie behaviour is unchanged.

## Requirements

### Requirement: Media type disambiguates the detail fetch

The system MUST determine media type from a `?type=tv` route query param (absent or any other value → movie) and MUST fetch TV details from `GET /api/v1/tv/{tmdbId}` for series and `GET /api/v1/movie/{tmdbId}` for movies. It MUST NOT fetch a movie for a series id (TMDB reuses numeric ids across namespaces).

#### Scenario: Series opens via the tv endpoint

- GIVEN a detail route `/detail/{id}?type=tv`
- WHEN the detail screen loads
- THEN details are fetched from `GET /api/v1/tv/{id}`
- AND TMDB's TV fields (`name`, `firstAirDate`, `episodeRunTime`) are normalized onto the shared detail shape (`title`, `releaseDate`, `runtime`)

#### Scenario: Movie link stays movie

- GIVEN a detail route `/detail/{id}` with no `type` param
- WHEN the detail screen loads
- THEN details are fetched from `GET /api/v1/movie/{id}` exactly as before

### Requirement: Navigation carries media type

The system MUST tag TV titles with `?type=tv` at every navigation site (poster cards, search results, home hero/rows) and MUST leave movie links param-less.

#### Scenario: Series poster navigates with the type param

- GIVEN a poster/result/hero for a series
- WHEN the user activates it
- THEN navigation targets `/detail/{id}?type=tv`

### Requirement: TV request submits the whole series

The system MUST submit a TV request via `POST api/v1/request` with `{mediaType: 'tv', mediaId, seasons: 'all'}`, and MUST keep the movie request body exactly `{mediaType: 'movie', mediaId}`.

#### Scenario: User requests a series

- GIVEN a `Requestable` series detail
- WHEN the user taps "Pedir"
- THEN a `POST` fires with `mediaType: 'tv'` and the whole series (`seasons: 'all'`)

### Requirement: InLibrary series does not offer direct playback

The system MUST show a non-navigating "En biblioteca" indicator for an `InLibrary` series (direct series playback needs episode selection, which is deferred), and MUST NOT show a "Reproducir" action that would route to a broken player.

#### Scenario: InLibrary series hides "Reproducir"

- GIVEN an `InLibrary` series detail
- WHEN the detail screen renders
- THEN a disabled "En biblioteca" indicator is shown
- AND no "Reproducir" action is shown

#### Scenario: InLibrary movie still plays

- GIVEN an `InLibrary` movie detail
- WHEN the detail screen renders
- THEN the "Reproducir" action is shown and navigates to the player (unchanged)
