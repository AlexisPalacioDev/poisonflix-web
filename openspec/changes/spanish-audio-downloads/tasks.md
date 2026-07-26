# Tasks: spanish-audio-downloads

Reads: `spec.md`, `design.md`
Status: **not started — Slice 2 blocked on Decision 1 (proposal §4)**

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~150 (audit script ~110, `.env` ~6, docs) — most of the work is service configuration, not code |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR; slices land as separate commits |
| Delivery strategy | ask-on-risk |
| Chain strategy | n/a |

Decision needed before apply: **Yes — Decision 1 (which Spanish source path) gates Slice 3 only.** Slices 1, 2, 4 and 5 are unblocked.

### Suggested Work Units

| Unit | Goal | Commit | Notes |
|------|------|--------|-------|
| 1 | Repair BFF `*arr` credentials | `fix(infra): restore real arr api keys in bff env` | Independent; **not** the audio fix |
| 2 | Baseline audit harness | `feat(infra): add spanish audio coverage audit` | Must land **before** slices 4 and 5 to have a before-number |
| 5 | Custom-format repair (`MULTi`, latino) | `fix(infra): score multi releases and prefer latino audio` | **Unblocked** — the only slice that helps without a new tracker |
| 3 | Spanish source pool in Prowlarr | `chore(infra): add spanish indexer sources` | **Blocked on Decision 1** |
| 4 | Cutoff-unmet upgrade sweep | no code — operational, recorded in apply report | Depends on 3 and 5 |

Recommended order: **1 → 2 → 5 → 3 → 4.**

Ordering rationale: the audit comes before everything that changes behaviour, or there is no before-number. Slice 5 lands before the sweep so the sweep evaluates against corrected scoring rather than being re-run later. Sources come before the sweep — reversed, the sweep correctly reports "nothing to upgrade" and misleads everyone.

## Slice 1: BFF credential repair

- [ ] 1.1 Back up the current file: `cp infra/.env infra/.env.bak-$(date +%F)`.
- [ ] 1.2 Read the real keys: `docker compose exec -T <svc> cat /config/config.xml` for `radarr`, `sonarr`, `prowlarr`; extract `<ApiKey>`.
- [ ] 1.3 Capture the currently running BFF env (`docker compose exec -T bff env`) and **diff** it against the rebuilt `.env` — confirm no variable other than the three keys changes (`JELLYFIN_URL`/`KEY`, `DATA_DIR`, the `*arr` URLs must survive).
- [ ] 1.4 Write the three corrected keys into `infra/.env`.
- [ ] 1.5 Recreate the container: `docker compose up -d --build bff` (the BFF is baked into the image; a restart is not enough).
- [ ] 1.6 **Verify from inside the container**: `system/status` on Radarr `:7878/api/v3`, Sonarr `:8989/api/v3`, Prowlarr `:9696/api/v1` → expect `200` on all three. Paste the output.
- [ ] 1.7 Smoke-check a BFF read that was previously broken (queue / library) and confirm it returns data.
- [ ] 1.8 Record in the apply report, explicitly: **this fixed BFF reads and changed no audio track.** Jellyseerr holds its own correct keys.

## Slice 2: Baseline audit harness

- [ ] 2.1 Write `infra/scripts/audit-audio-languages.py` (stdlib only — no new dependency, no new container).
- [ ] 2.2 Enumerate library items from Jellyfin (Movies and Series/Episodes separately), then fetch `/Users/{userId}/Items/{id}?Fields=MediaStreams` per item.
- [ ] 2.3 Per item, emit: `Path`, item type, every audio stream's `Language` + `Codec`, and a `hasSpanish` boolean.
- [ ] 2.4 Classification: Spanish ⇔ `spa` or an `es`-prefixed tag. `und`/empty/absent ⇒ **untagged bucket**, never counted as Spanish and never as English.
- [ ] 2.5 Aggregate **split by Movies and Series** — a blended ratio would have hidden the real finding (4/7 vs 0/4).
- [ ] 2.6 Write output to a timestamped file so before/after is a diff, not a memory.
- [ ] 2.7 **Verify the audit against the known baseline**: it MUST reproduce ≈4/7 movies and 0/4 series on the manually inspected sample. If it does not, the audit has a bug — fix the audit, do not adjust the expectation.
- [ ] 2.8 Run it over the full library and commit the baseline output.

## Slice 3: Spanish source pool — **BLOCKED on Decision 1**

> Do not start until the user picks 1a / 1b / 1c. Recommendation on record: **1c**.

### If 1a (private tracker)
- [ ] 3a.1 Obtain access to `Lat-Team` (es-MX — the only Latin-American definition, and it carries TV) and/or a castellano TV tracker (`HD-Olimpo`, `Torrenteros`, `HDZero`, `ParabellumHD`).
- [ ] 3a.2 Add the indexer in Prowlarr with its credentials; confirm the built-in test passes.
- [ ] 3a.3 Confirm it app-syncs to **both** Radarr and Sonarr (`GET /api/v1/indexer` and the *arr indexer list).

### If 1b (custom Cardigann definitions)
- [ ] 3b.1 **Verify first**, do not assume: confirm this Prowlarr build loads `/config/Definitions/Custom/` and record the Cardigann schema version it expects. Check the Prowlarr log after a restart — a definition that fails to parse is reported only there.
- [ ] 3b.2 Add YAML definitions for the public Spanish sites Prowlarr does not ship.
- [ ] 3b.3 Confirm each appears in the indexer list and its test passes.

### Both paths
- [ ] 3.4 **Live search proof for TV** — search a known series and confirm at least one returned title carries a marker `detectLanguages()` recognises (`latino`, `latam`, `castellano`, `español`, `spanish`, `dual`, `multi`). An enabled indexer returning nothing is the exact failure this change exists to remove; enabling it is not the deliverable, results are.
- [ ] 3.5 Confirm the new source is categorised under **TV**, not only Movies.
- [ ] 3.6 Do **not** raise `minFormatScore` (Decision 2) and do **not** re-tune existing scores — the only permitted format work is the additive repair in Slice 5 (Decision 3).

## Slice 5: Custom-format repair — **unblocked, do this before the sweep**

- [ ] 5.1 Record the **before** state: run `/api/v3/parse` on the `explore.md` §2.1 title set against **both** Radarr and Sonarr, and save the output. Expected: `MULTi` → no formats; `Latino` → `Espanol`+`Latino` (380); `Castellano` → `Espanol`+`Lang: Spanish` (380).
- [ ] 5.2 Add a `MULTi` custom format on both services — `ReleaseTitleSpecification`, pattern `\bmulti\b`, scored ~150 on profile `id 6` (the `Dual` band, deliberately below the Spanish band).
- [ ] 5.3 Read the `Spanish (Latino)` language id from each instance: `GET /api/v3/language`. **Do not hard-code it** — Radarr is 6.3.0 and Sonarr is 4.0.19, and this is exactly the kind of value that differs.
- [ ] 5.4 Add a `Lang: Spanish (Latino)` custom format on both services — `LanguageSpecification` with that id, scored ~300 on profile `id 6`.
- [ ] 5.5 Confirm **no existing score changed** (300/150/80/50 intact) — this slice is purely additive.
- [ ] 5.6 Verify with `/parse` on the same title set: `MULTi` now scores > 0, and latino now scores strictly above castellano. Verify Sonarr separately from Radarr; do not assume they behave identically.
- [ ] 5.7 Paste the before/after diff into the apply report.

## Slice 4: Cutoff-unmet upgrade sweep

- [ ] 4.1 Record free space on `/media/data1` and `/media/data2` — upgrades add before they replace.
- [ ] 4.2 Read the **available commands from the running instances** (`GET /api/v3/command`) rather than hard-coding a command name from memory; Radarr 6.3.0 and Sonarr 4.0.19 differ.
- [ ] 4.3 Record the cutoff-unmet counts for Radarr and Sonarr **before** the sweep.
- [ ] 4.4 **Bounded first run**: trigger an upgrade search for a small set of known-English items from the Slice 2 baseline. If this produces no Spanish grab, stop — the source pool is still the problem and a full sweep would be expensive noise.
- [ ] 4.5 Full Radarr sweep. Observe the qBittorrent queue before continuing.
- [ ] 4.6 Full Sonarr sweep — never simultaneously with Radarr.
- [ ] 4.7 Confirm RSS-driven upgrades need no change (`upgradeAllowed: true`, `cutoffFormatScore: 300`, `minUpgradeFormatScore: 1` already set — assert, do not modify).
- [ ] 4.8 Re-run the Slice 2 audit and diff against the baseline. Report the new ratio, or a documented explanation of why it did not move.

## Definition of done

- [ ] All three `system/status` endpoints return `200` from inside the `bff` container.
- [ ] The audit reproduces the manual baseline (≈4/7 movies, 0/4 series), then runs over the full library, with output committed.
- [ ] `/parse` shows `MULTi` > 0 and latino > castellano on **both** Radarr and Sonarr, with the before/after diff recorded.
- [ ] No pre-existing custom-format score was modified.
- [ ] At least one Spanish TV source is enabled **and proven to return Spanish-marked TV results**.
- [ ] Cutoff-unmet counts recorded before/after and at least one upgrade grab observed.
- [ ] Post-sweep audit shows a strictly higher Spanish ratio, or documents why not.
- [ ] Apply report states plainly which slices moved the audio number and which did not — the credential fix must not be credited with an audio improvement.
