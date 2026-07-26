# Spanish Audio Specification — DELTA

## Purpose

Requirements for requested movies and series arriving with a **Spanish audio track**, and for that outcome being measurable. Subtitles are out of scope — no requirement here concerns Bazarr or any subtitle file.

This is a delta over existing behaviour: the release-scoring configuration is already correct and is asserted here only so a future change cannot silently regress it.

## Requirements

### Requirement: The indexer pool MUST contain a Spanish-language source that carries TV

The system MUST have at least one enabled Prowlarr indexer that returns Spanish-audio releases for **television series**, in addition to the existing `Elitetorrent-wf` (es-ES, film-leaning). Enabling only film-oriented or castellano-only sources does NOT satisfy this requirement, because series is the observed total-failure case (0/4).

#### Scenario: A Spanish TV source returns candidates

- GIVEN a Spanish-language indexer enabled in Prowlarr
- WHEN a manual search runs for a known series title
- THEN at least one returned release title carries a Spanish marker recognised by `detectLanguages()` (`latino`, `latam`, `castellano`, `español`, `spanish`, `dual`, `multi`)
- AND the release is categorised under TV, not only Movies

#### Scenario: The pool is verified, not assumed

- GIVEN any claim that Spanish sources are configured
- WHEN the claim is made
- THEN it MUST be backed by the output of `GET /api/v1/indexer` showing the indexer enabled
- AND by a live search returning at least one Spanish-marked result

### Requirement: Scoring claims MUST be measured, not read from config

Any assertion about how release candidates rank MUST be backed by `GET /api/v3/parse?title=…` output from the running instance, on **both** Radarr and Sonarr. Reading the quality profile JSON is NOT sufficient evidence.

#### Scenario: A ranking claim is made

- GIVEN a claim that some release flavour outranks another
- WHEN the claim is recorded
- THEN it MUST cite `/parse` output showing which custom formats the title actually matched
- AND the two services MUST be checked separately, because they run different major versions (Radarr 6.3.0, Sonarr 4.0.19)

#### Scenario: Config appears correct but composes incorrectly

- GIVEN a profile containing both `Latino` (+300, title regex) and `Lang: Spanish` (+300, LanguageSpecification id 3)
- WHEN a latino-marked release is parsed
- THEN it is classified as language `Spanish (Latino)`, a distinct id from `Spanish`
- AND `Lang: Spanish` does NOT fire
- AND the apparent latino preference does NOT exist in effect

### Requirement: A latino release MUST outrank a castellano release

The system MUST score a Latin-American Spanish release strictly above a castellano release, which MUST score strictly above an English-only release, on profile `id 6` — the profile Jellyseerr uses for movies, series and anime.

#### Scenario: Latino currently ties castellano (defect to fix)

- GIVEN the profile as configured before this change
- WHEN `Latino` and `Castellano` titles are parsed
- THEN both score 380
- AND this MUST be treated as a defect, not as the intended preference

#### Scenario: Latino outranks castellano after the fix

- GIVEN a `LanguageSpecification` custom format for the `Spanish (Latino)` language
- WHEN a latino-marked release is parsed
- THEN it scores strictly above an equivalent castellano-marked release
- AND the language id MUST be read from `GET /api/v3/language` on each instance, NOT hard-coded

#### Scenario: Sonarr v4 expresses language via custom formats only

- GIVEN Sonarr 4.x, where language profiles were removed
- WHEN language preference is configured
- THEN it MUST be expressed as custom formats with scores on the quality profile
- AND the absence of a `language` key on the Sonarr profile MUST NOT be treated as missing configuration

### Requirement: A `MULTi` release MUST outrank an English-only release

The system MUST score releases marked `MULTi` above untagged English releases, because `MULTi` is empirically the marker that delivered Spanish audio for library items that have it.

#### Scenario: MULTi currently scores zero (defect to fix)

- GIVEN the profile as configured before this change
- WHEN a `MULTi` title is parsed
- THEN it matches no custom format and scores 0
- AND it therefore ties an untagged English release, despite carrying Spanish audio in practice

#### Scenario: MULTi scores in the Dual band after the fix

- GIVEN a `MULTi` custom format
- WHEN a `MULTi` title is parsed
- THEN it scores above an untagged English release
- AND strictly below an explicitly Spanish-marked release, because `MULTi` promises several languages, not Spanish specifically

#### Scenario: Existing weights are not re-tuned

- GIVEN the existing scores 300 / 150 / 80 / 50
- WHEN the custom-format repair is applied
- THEN no existing score is changed
- AND only new formats are added, so no currently-preferred release becomes less preferred

### Requirement: An English-only grab MUST remain eligible for upgrade

The system MUST NOT block a download when no Spanish release exists. It MUST download the best available candidate and MUST leave that item eligible for a later replacement by a Spanish release.

#### Scenario: No Spanish candidate exists

- GIVEN a requested title with only English releases available
- WHEN the search completes
- THEN the English release IS grabbed
- AND the item is NOT left unfulfilled

#### Scenario: The grabbed item stays below cutoff

- GIVEN an untagged English grab scoring 0 (measured — such releases parse as language `Unknown`, so `Lang: English +150` does not fire)
- AND a profile with `cutoffFormatScore: 300`, `upgradeAllowed: true`, `minUpgradeFormatScore: 1`
- WHEN the item is evaluated
- THEN it is reported as cutoff-unmet
- AND a later Spanish release scoring above 300 replaces it

#### Scenario: Spanish is never hard-required

- GIVEN the active quality profile
- WHEN `minFormatScore` is read
- THEN it MUST be `0`
- AND no reject-scored custom format MUST target the English language

### Requirement: The existing English-only library MUST be re-evaluated once

Correct-but-dormant upgrade configuration MUST be converted into actual upgrades. Radarr and Sonarr only act on cutoff-unmet items via RSS sync or an explicit search, so the pre-existing library will not self-heal.

#### Scenario: Cutoff-unmet sweep is triggered

- GIVEN a library containing items downloaded before Spanish sources existed
- WHEN the change is applied
- THEN a cutoff-unmet search is triggered for Radarr and for Sonarr
- AND the number of items found eligible is recorded in the apply report

#### Scenario: The sweep does not overwhelm the downloader

- GIVEN a cutoff-unmet sweep
- WHEN it is triggered
- THEN it MUST be run one service at a time
- AND the qBittorrent queue MUST be observed before triggering the second

### Requirement: BFF credentials MUST match the *arr services

The system MUST hold, in `infra/.env` and in the running `bff` container, the API keys that each *arr service reports in its own `config.xml`.

#### Scenario: Keys authenticate

- GIVEN the keys in `infra/.env`
- WHEN `GET /api/v3/system/status` is called on Radarr and Sonarr, and `GET /api/v1/system/status` on Prowlarr, from inside the `bff` container
- THEN each returns HTTP `200`
- AND none returns `401`

#### Scenario: This fix is not credited with the audio outcome

- GIVEN the credential repair
- WHEN its effect is described
- THEN it MUST be stated that Jellyseerr holds its own correct keys and bypasses the BFF
- AND that no audio track changes as a result

### Requirement: Spanish-audio coverage MUST be measurable and repeatable

The system MUST provide a repeatable audit reporting, per library item, whether a Spanish audio track is present — read from the media file as probed by Jellyfin, not from *arr metadata.

#### Scenario: Audit reports per-item audio languages

- GIVEN a Jellyfin library
- WHEN the audit runs
- THEN for each item it reports the file path, every audio stream's language tag, and whether any is Spanish
- AND it reports an aggregate ratio split by Movies and Series

#### Scenario: Audit uses the file, not the *arr guess

- GIVEN a discrepancy between a release's parsed language and the file's actual tracks
- WHEN the audit reports
- THEN it MUST use Jellyfin `MediaStreams`
- AND it MUST NOT infer language from the release title or *arr history

#### Scenario: Untagged tracks are not counted as Spanish

- GIVEN an audio stream whose `Language` is `und`, empty, or absent
- WHEN the audit classifies it
- THEN it MUST NOT be counted as Spanish
- AND it MUST be reported separately as untagged, so scan gaps stay visible
