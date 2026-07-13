# Availability Preview Specification

## Purpose

Defines the pre-download availability panel on the detail screen: whether a title exists on the torrent indexers and in which languages, sourced from a Prowlarr manual search over a same-origin proxy that injects the API key server-side.

## Requirements

### Requirement: Same-origin Prowlarr access with server-side key injection

The system MUST reach Prowlarr through a same-origin `/prowlarr/*` proxy that injects the `X-Api-Key` header server-side. The browser MUST NOT attach a Prowlarr credential of its own, and the key MUST NOT appear in the client bundle.

#### Scenario: Browser issues a keyless relative request

- GIVEN the app is served same-origin behind the proxy
- WHEN the client searches Prowlarr
- THEN it issues a relative `/prowlarr/api/v1/search` request with no `X-Api-Key` of its own
- AND the proxy attaches `X-Api-Key` before forwarding to Prowlarr

#### Scenario: Missing production key

- GIVEN `PROWLARR_API_KEY` is not set in the proxy environment
- WHEN a Prowlarr search is proxied
- THEN no key is injected (the request is forwarded keyless) rather than a build-time secret being embedded in the client

### Requirement: Availability summary from a Prowlarr search

The system MUST search Prowlarr for the current title and summarize the results into: found (boolean), total relevant releases, maximum seeders, and a per-language breakdown. A release whose reported `tmdbId` differs from the title's MUST be excluded; releases with a matching id — or no id — MUST be kept.

#### Scenario: Title found on the indexers

- GIVEN a title with matching releases on the indexers
- WHEN the availability query resolves
- THEN the panel shows "Disponible en torrents" with the release count, best seeder count, and a per-language breakdown

#### Scenario: Title not found

- GIVEN a title with no matching releases
- WHEN the availability query resolves
- THEN the panel shows "No encontrado en torrents"

#### Scenario: Wrong-title release filtered out

- GIVEN a search result whose `tmdbId` is present and differs from the viewed title's `tmdbId`
- WHEN the results are summarized
- THEN that release is excluded from the counts and language breakdown

### Requirement: Language inference from release titles

The system MUST derive each release's languages from its title (Prowlarr returns no structured languages), MUST classify a release with no foreign-language marker as English, and MUST treat a MULTI/DUAL release as including English.

#### Scenario: Unmarked release counts as English

- GIVEN a release title with no language marker (e.g. `Movie.1080p.BluRay.x264`)
- WHEN languages are detected
- THEN it is classified as English

#### Scenario: Spanish variants distinguished

- GIVEN a release tagged "Latino" (or "Castellano")
- WHEN languages are detected
- THEN it is classified as the specific Spanish variant and not double-counted as generic Spanish

### Requirement: Panel is non-blocking on the detail screen

The system MUST render the availability panel from its own query with its own loading/error state, and MUST NOT block the detail screen's title, overview, or primary action on the availability result.

#### Scenario: Slow or failed indexer search degrades gracefully

- GIVEN the Prowlarr search is slow or fails
- WHEN the detail screen renders
- THEN the poster, overview, and "Pedir" action still render
- AND the panel shows a loading or muted "no se pudo consultar" state without blanking the screen
