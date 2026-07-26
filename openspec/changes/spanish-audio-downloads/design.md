# Design: spanish-audio-downloads

Reads: `proposal.md`, `specs/spanish-audio/spec.md`
Feeds: `sdd-tasks`
Status: design complete; **Slice 2 blocked on Decision 1**

## 1. Where the leverage actually is

The pipeline is:

```
app (SPA) ──POST /api/v1/request {mediaType, mediaId}──▶ Jellyseerr
                                                            │  (own API keys, profile id 6)
                                                            ▼
                                                    Radarr / Sonarr
                                                            │  custom-format scoring
                                                            ▼
                                                        Prowlarr ──▶ 22 indexers
                                                            │
                                                            ▼
                                                       qBittorrent ──▶ /media/dataN ──▶ Jellyfin
```

Four layers were checked; two are healthy:

| Layer | State | Evidence |
|---|---|---|
| SPA / BFF | Language-agnostic **by design** | `requestMedia()` sends `{mediaType, mediaId}` only (`jellyseerr.ts:160-171`); BFF allowlist has no add-with-profile route (`server.mjs:137-160`) |
| Jellyseerr | Correct | Right API keys, `activeProfileId: 6` for movies/series/anime, no override |
| Radarr / Sonarr | **Right idea, two coverage gaps** | Measured via `/api/v3/parse`: `MULTi` = 0, latino = castellano = 380. Thresholds fine (`upgradeAllowed: true`, `cutoffFormatScore: 300`, `minUpgradeFormatScore: 1`) |
| **Prowlarr** | **Broken by omission** | 1 of 21 enabled indexers is Spanish, and it is castellano film-leaning |

Design principle: **do not touch the healthy layers, and fix the unhealthy ones at the smallest possible radius.** Changes land at the Prowlarr layer (sources), as two additive custom formats at the *arr layer, plus one dormant-config trigger and one unrelated credential repair.

This matters because the tempting fix — threading a language preference from the SPA through to Radarr — would be a large, testable-looking change that produces **zero** additional Spanish tracks. Scoring cannot pick a Spanish release out of a result set that contains none.

### 1.1 Read the config, or measure it

The *arr layer was originally written up here as healthy, on the strength of the config reading correctly: `Latino +300` exists, `Lang: Spanish +300` exists, English is +150. That was wrong, and it was wrong in the way config review is usually wrong — every individual value is defensible and the *composition* is not.

`GET /api/v3/parse?title=…` settles it, because it reports which formats a given title actually matches. It is the cheapest possible check and it changed two conclusions (§3, §5). Any future claim in this change about scoring must come from `/parse` output, not from the profile JSON.

## 2. Slice 1 — BFF credential repair

**Mechanism.** Read the truth from each service's own config, write it to `infra/.env`, recreate the container.

```
docker compose exec -T radarr   cat /config/config.xml   # <ApiKey>…</ApiKey>
docker compose exec -T sonarr   cat /config/config.xml
docker compose exec -T prowlarr cat /config/config.xml
```

**Why the container must be recreated, not restarted.** The BFF is **baked into its image** (no bind mount) and reads env at process start, so `docker compose up -d --build bff` is required. This is a known gotcha in this stack — the same applies to `music-worker`.

**Safety.** `infra/.env` was hand-reconstructed once already and got it wrong; that is exactly how the fabricated keys got there. So: back the file up, and **diff the rebuilt env against the currently running container env** before recreating, so any *other* variable the hand-built file happens to carry (`JELLYFIN_URL`/`KEY`, `DATA_DIR`, the *arr URLs) is preserved rather than silently dropped. A blank variable here does not fail loudly — it fails as a confusing runtime error later.

**Verification is from inside the container**, not from the host, because that is where the failure was originally observed and the network path differs.

## 3. Slice 2 — Spanish source pool (blocked on Decision 1)

### 3.1 Why this cannot be a config toggle

`GET /api/v1/indexer/schema` returns 626 definitions; 15 are Spanish; **1 is public and carries film/TV, and it is already enabled.** Name-searching all 626 for the well-known public Spanish sites (`DonTorrent`, `MejorTorrent`, `DivxTotal`, `Wolfmax4K`, `EstrenosGO`, `Todotorrents`, `Torrentrapid`, `AtomixHQ`, `GranTorrent`, `Cinecalidad`) yields **zero hits**. Prowlarr simply does not ship them.

### 3.2 Option 1a — private tracker

`Lat-Team` (es-MX) is the only Latin-American definition in the catalog and is the single highest-value item in this change, because **it carries TV** — the 0/4 case. Castellano alternatives (`HD-Olimpo`, `Torrenteros`, `HDZero`, `ParabellumHD`) also carry TV.

Integration is mechanical once credentials exist: add the indexer in Prowlarr with its API key/passkey, confirm it syncs to Radarr and Sonarr as an app-synced indexer, and confirm a live search returns Spanish-marked titles. The *blocker is human*, not technical.

### 3.3 Option 1b — custom Cardigann definitions

Prowlarr loads user-supplied YAML from `/config/Definitions/Custom/` inside the container. This is the escape hatch for sites Prowlarr does not ship.

**Must be verified before relying on it**, not assumed: confirm this Prowlarr build reads that path, and confirm the Cardigann schema version the build expects (definitions written for a different `requestDelay`/`settings` schema fail to load, and Prowlarr reports this only in its log). A definition that silently fails to load looks identical to a tracker with no results — which is precisely the failure mode this change exists to remove.

**Maintenance reality.** These definitions scrape HTML. They break when a site changes markup, and they break *silently*. That is the argument for Slice 4 being a scheduled audit rather than a one-off check.

### 3.4 Ordering

Add sources **before** the upgrade sweep. Running the sweep first would produce a confident, correct report saying "nothing to upgrade" — technically true and completely misleading, because there would be no Spanish candidates to upgrade *to*. Sequence matters more than it looks here.

## 4. Slice 3 — Upgrade sweep

### 4.1 The config is already right; it has just never fired

An untagged English grab scores **0** against `cutoffFormatScore: 300`, with `upgradeAllowed: true` and `minUpgradeFormatScore: 1` (any improvement counts). That means every English-only item in the library is **already** flagged cutoff-unmet and already eligible for replacement. (The 0 is measured — untagged scene releases parse as language `Unknown`, so `Lang: English +150` does not fire; see `explore.md` §2.4. The direction is unchanged, the margin is simply wider than the config suggests.) Radarr and Sonarr act on that in two ways:

- **RSS sync** — catches *new* releases as they appear. Works going forward, automatically. No action needed.
- **Explicit search** — the only way to re-evaluate items already on disk.

Hence the one-off sweep. It is not a config change; it is a trigger.

### 4.2 Mechanism

Radarr and Sonarr expose this through `POST /api/v3/command`. The exact command names and payload shape differ between the two and between versions, so apply **must read the available commands from the running instance** (`GET /api/v3/command` and the service's own cutoff-unmet view) rather than hard-coding a name from memory. Sonarr is 4.0.19.2979; Radarr's version should be recorded at apply time.

Fallback if the command surface is awkward: the cutoff-unmet list itself is queryable, and a bounded per-item search can be issued for a subset. Prefer the bounded path first anyway — see below.

### 4.3 Blast radius

A full sweep across the whole library can enqueue a large number of torrents at once. Controls:

- Radarr first, then Sonarr — never both at once.
- Inspect the qBittorrent queue between the two.
- Prefer a **bounded first run** (a handful of known-English series from the audit's baseline) to prove the mechanism end-to-end before sweeping everything.
- Record free space on `/media/data1` and `/media/data2` first; upgrades *add* before they replace.

The point of the bounded run is falsifiability: if a targeted upgrade on a known-English series does not produce a Spanish grab, the source pool is still the problem and the full sweep would just be expensive noise.

## 5. Slice 4 — Audit harness

**Data source: Jellyfin `MediaStreams`.** Per item: `/Users/{userId}/Items/{id}?Fields=MediaStreams`, reading each audio stream's `Language`, plus the item `Path`.

**Why not *arr history.** History records what was grabbed and what the *arr parser *believed* the language to be. The failure mode under investigation is precisely that belief diverging from the file — `Hoppers` landed `und`, `Mr. Robot` landed an untagged English track. The file is the only source that cannot lie about itself.

**Classification rules** (deliberately strict):

- Spanish ⇔ an audio stream whose `Language` is `spa` (or an `es`-prefixed tag).
- `und` / empty / absent ⇒ **untagged**, reported in its own bucket. Never counted as Spanish, never silently counted as English. Undertagging is a real and separate problem; folding it into either bucket would hide it.
- Aggregate reported **split by Movies and Series**, because the two have completely different failure rates (4/7 vs 0/4) and a blended number would have hidden the actual finding.

**Output.** Machine-readable per-item rows plus a summary. Writing the baseline to a file makes before/after a diff rather than a memory.

**Placement.** A script under `infra/` in the web repo, run over SSH. It needs no new container and no new dependency — Jellyfin's API key already exists.

**Cadence.** Run once for the baseline, once after the sweep, and then periodically — because custom Cardigann definitions (§3.3) degrade silently and this audit is the detector.

## 5b. Slice 5 — Custom-format repair

The only slice that improves outcomes **without** a new tracker, so it should land early and be measured on its own.

### 5b.1 `MULTi` — a coverage hole, not a tuning question

Measured: `MULTi` matches no custom format and scores 0, tying an untagged English release. Meanwhile `Avatar - Fire and Ash` — one of the four movies in the audit that actually carried Spanish audio — is a `MULTi` release.

Fix: a `ReleaseTitleSpecification` on `\bmulti\b`, scored in the `Dual` band (~150). Deliberately *not* in the `Latino`/`Spanish` band: `MULTi` promises "several languages", not "Spanish", so it should beat English-only and lose to an explicitly Spanish release.

Alternative rejected: widening the existing `Dual` regex to include `multi`. It works, but it silently changes the meaning of a format named "Dual" — the next person reading a score breakdown would see `Dual` matched on a release with eight audio tracks and distrust the whole table. A separate format keeps the score explainable.

### 5b.2 Latino — the preference that cancels itself

Measured: latino 380, castellano 380. The mechanism is worth stating precisely because it is not obvious from the config:

- `Latino` (title regex `\b(latino|latam)\b`) fires for latino, **not** castellano → +300
- `Lang: Spanish` (LanguageSpecification, id 3) fires for castellano, **not** latino → +300
- `Espanol` (title regex) fires for both → +80

The two +300s never fire together and never fire for the same release. They cancel. Radarr/Sonarr classify `Latino` as the language **`Spanish (Latino)`**, which is a distinct id from `Spanish`.

Fix: add a `LanguageSpecification` for `Spanish (Latino)`. The exact id must be **read from the running instance** (`GET /api/v3/language`) rather than hard-coded — it differs across *arr versions, and this stack runs Radarr 6.3.0 alongside Sonarr 4.0.19.

Scoring it in the ~300 band puts latino at ~680 against castellano's 380 — the ordering the config always appeared to have.

### 5b.3 Why this is low-risk

Both changes are **additive**: no existing weight moves, so no currently-preferred release becomes less preferred. The worst case is that a release which previously scored 0 now scores 150, which can only displace another release scoring below that — i.e. an English-only one. That is the intent.

The check is a before/after diff of `/parse` output over the fixed title set in `explore.md` §2.1, on **both** services. Sonarr must be verified separately from Radarr rather than assumed identical: they run different major versions, and the language-id lookup in 5b.2 is exactly the kind of thing that diverges.

## 6. What is deliberately not built

| Not built | Why |
|---|---|
| Per-request `profileId` override from the SPA | Jellyseerr accepts it, but the global default profile already expresses the preference. Adds a UI decision the user has not asked for, and produces no extra Spanish releases |
| Changes to `releaseLanguage.ts` | Verified correct and display-only by design. Its unmarked-⇒-english convention matches the *arr parser convention |
| Re-tuning existing scores (300/150/80/50) | The defects are missing coverage, not wrong weights. Slice 5 adds two formats and moves none |
| Reject-English custom format | Directly contradicts the user's chosen policy; would have blocked 3/7 movies and 4/4 series |
| Anything touching Bazarr | Out of scope by explicit decision |

## 7. Verification strategy

Each slice has an observable, pasteable check — no slice is "done" on the strength of a config file looking right:

1. **Slice 1 (credentials)** — `curl` all three `system/status` endpoints from *inside* the `bff` container; expect `200`, not `401`.
2. **Slice 2 (audit)** — the audit reproduces the known baseline (≈4/7 movies, 0/4 series) on first run. If it does not, the audit is wrong, not the library.
3. **Slice 3 (sources)** — `GET /api/v1/indexer` shows the new indexer enabled, **and** a live search for a known series returns at least one Spanish-marked title. The second half is the one that matters; an enabled indexer returning nothing is the exact failure this change is about.
4. **Slice 4 (sweep)** — cutoff-unmet counts recorded before and after; at least one grab observed in the Radarr/Sonarr queue.
5. **Slice 5 (formats)** — `/api/v3/parse` over the `explore.md` §2.1 title set, on both services, showing `MULTi` > 0 and latino > castellano.

Two of these are load-bearing guards rather than checkboxes. The audit must reproduce the manually-verified baseline, because an audit that cannot has a bug and every number it produces afterwards is worthless. And Slice 5 must be verified with `/parse` rather than by re-reading the profile — reading the config is precisely what produced the wrong conclusion this design had to correct (§1.1).
