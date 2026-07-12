# Onboarding Specification

## Purpose

Defines the two-phase, both-or-nothing authentication flow that gates all access to poisonflix-web: the user enters Jellyfin + Jellyseerr URLs and a shared username/password, and a session is persisted only when BOTH backends authenticate successfully. Mirrors `OnboardingViewModel.kt` L44-51/L130-142.

## Requirements

### Requirement: Two-panel credential form

The system MUST present a form collecting the Jellyfin server URL, the Jellyseerr server URL, and a single shared username/password pair used against both backends.

#### Scenario: Form fields present

- GIVEN the user is unauthenticated
- WHEN they land on `/onboarding`
- THEN the form renders four fields: Jellyfin URL, Jellyseerr URL, username, password

### Requirement: Both-or-nothing two-phase authentication

The system MUST authenticate against Jellyfin first, then Jellyseerr, and MUST NOT persist any session unless BOTH succeed (`OnboardingViewModel.kt` L44-51/L130-142).

#### Scenario: Happy path — both succeed

- GIVEN valid credentials for both backends
- WHEN the user submits the form
- THEN Jellyfin `authenticateByName` succeeds, then Jellyseerr `authJellyfin` succeeds
- AND the session (token + userId + cookie marker) is persisted and the app routes to Home

#### Scenario: Jellyfin auth fails — stop before Jellyseerr

- GIVEN invalid Jellyfin credentials
- WHEN the user submits the form
- THEN Jellyfin auth fails, no Jellyseerr request is made, and nothing is persisted

#### Scenario: Jellyfin succeeds, Jellyseerr fails — discard

- GIVEN valid Jellyfin credentials but invalid/unreachable Jellyseerr auth
- WHEN the user submits the form
- THEN the Jellyfin token already obtained is discarded and nothing is persisted

### Requirement: Session persists across reload

The system MUST hydrate an existing session from storage on app boot and route directly to Home, skipping onboarding.

#### Scenario: Reload after successful onboarding

- GIVEN a previously persisted session exists in localStorage
- WHEN the app reloads
- THEN the user is routed to Home without re-entering credentials

### Requirement: Distinct error for proxy misconfiguration vs auth failure

The system MUST render a different error message for a same-origin proxy/CORS connectivity failure than for an invalid-credentials (401) failure, so a misconfigured reverse-proxy path prefix is not mistaken for a wrong password.

#### Scenario: Proxy/CORS misconfiguration

- GIVEN the reverse proxy's `/jellyfin` or `/jellyseerr` path prefix is misconfigured or unreachable
- WHEN the user submits the form
- THEN a `NetworkError`/`CorsError` is surfaced with a connectivity/proxy-specific message, distinct from a credentials error

#### Scenario: Invalid credentials (401)

- GIVEN the proxy is correctly configured but the password is wrong
- WHEN the user submits the form
- THEN an `ApiError(401)` is surfaced with an invalid-credentials message

## Deferred

- Runtime-configurable path prefixes beyond the fixed `/jellyfin` and `/jellyseerr` env defaults.
- Onboarding for the webOS `.ipk` distribution (on-screen keyboard input).
