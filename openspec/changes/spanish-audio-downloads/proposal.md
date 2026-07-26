# Proposal: spanish-audio-downloads

Status: proposed — **blocked on Decision 1 (user GO required before apply)**
Change: `spanish-audio-downloads`
Reads: `explore.md`
Feeds: `sdd-spec`, `sdd-design`
Scope decided with the user up front: **audio only**; subtitles/Bazarr explicitly excluded.
Policy decided with the user: **prefer + auto-upgrade** — never leave a hole in the library; grab English now and replace it when Spanish appears.

## 1. Intent

Make requested movies and series actually arrive with **Spanish audio**, and make that outcome **measurable** instead of anecdotal.

The problem was verified empirically, not inferred: of 12 downloaded items inspected via Jellyfin `MediaStreams`, movies carried a Spanish track **4/7** and series **0/4**. The Spanish tracks are genuinely absent from the files — this is a release-selection failure, not a playback or UI failure.

The investigation killed the intuitive explanation and replaced it with a less convenient one. The Radarr API-key 401 is **not** in the download path — Jellyseerr holds the correct keys and talks to the *arr services directly. What is actually missing is upstream of everything: **of 21 enabled Prowlarr indexers, exactly one is Spanish, and it is es-ES castellano, film-leaning.** No amount of scoring can pick a latino release out of a result set that contains none.

Radarr/Sonarr scoring was *also* checked — by measuring it through `GET /api/v3/parse`, not by reading the config — and it turned up two contained defects worth fixing regardless of the tracker situation: **`MULTi` scores 0** (and `MULTi` is exactly how the one clearly-working movie case got its Spanish track), and **latino ties castellano at 380** because `Latino` parses as `Spanish (Latino)`, a different language id, so `Lang: Spanish +300` never fires for it.

Success means: a newly requested series lands with a Spanish audio track when one exists anywhere in the configured pool; the existing English-only library gets upgraded over time rather than re-downloaded by hand; and a repeatable audit reports the Spanish-track ratio so the next change can be judged against a number.

## 2. Scope

### In scope
- **Spanish source pool** — expand Prowlarr beyond the single `Elitetorrent-wf` (es-ES) indexer so Spanish-audio releases, *especially for TV*, are actually returned to the scorers. See Decision 1.
- **Custom-format repair** — add a `MULTi` format, and make the latino preference actually take effect. Two additive changes, no re-tuning of existing scores. Independent of Decision 1: this is the only slice that can improve outcomes without a new tracker.
- **Upgrade sweep** — trigger a one-off cutoff-unmet search across the existing Radarr/Sonarr library so already-downloaded English-only files are re-evaluated against the (correct) Spanish scoring, and keep RSS-driven upgrades working thereafter.
- **BFF credential repair** — `infra/.env` carries fabricated API keys (401 against all three services). Fix it and recreate the `bff` container. Explicitly de-scoped from the audio outcome: this repairs the BFF's own reads (queue, library), nothing else.
- **Audit harness** — a repeatable script that reports, per library item, whether a Spanish audio track is present, so before/after is a measurement rather than an opinion.

### Out of scope
- **Subtitles / Bazarr** — a separate problem with a separate owner; excluded by explicit user decision.
- **Hard-requiring Spanish** (`minFormatScore > 0` or an English reject rule) — rejected by the user's chosen policy. On the observed sample it would have blocked 3/7 movies and 4/4 series from ever downloading.
- **Re-tuning the existing custom-format scores** — the relative weights (300/150/80/50) are sound; the defects are *missing* coverage, not wrong numbers. Slice 5 adds formats, it does not re-balance them.
- **Rewriting the request path in the SPA** to send a per-request profile override — see Deferred; the server-side default profile already expresses the preference globally.
- **Any change to `releaseLanguage.ts`** — it works, and it is display-only by design.

### Deferred (seams kept open)
- **Per-request language/profile override from the app.** Jellyseerr's `POST /api/v1/request` accepts `profileId`; a second "Spanish-first" Radarr profile could be selected per request from the detail screen. Only worth it if the global preference proves too blunt.
- **Surfacing actual audio tracks in the UI.** Today `AvailabilityPanel` shows what languages *exist on the indexers* before requesting, but nothing shows what languages the *downloaded file* has. The audit harness (Slice 4) produces exactly that data; promoting it into the detail screen is a natural follow-up.
- **Pruning the 8 adult indexers** from the search pool (or moving them to a tag-scoped set) — suspected to slow every search; unmeasured.
- **Jellyfin default-track selection** — moot while the tracks are absent; revisit once Slice 2 lands.

## 3. Approach

The leverage is **upstream, not in the code**. Scoring can only choose among what the indexers return, so the change is sequenced source → policy → measurement, with the unrelated credential bug fixed alongside.

- **Widen the source pool first (Slice 2).** Nothing else in this change can produce a single extra Spanish track until this lands. This is also the only slice that needs a human decision, because Prowlarr's catalog offers no public alternative (Decision 1).
- **Let the existing scoring do its job.** No score changes. Radarr/Sonarr already rank latino above castellano above english; the fix is to give them Spanish candidates to rank.
- **Heal the existing library by upgrade, not re-download (Slice 3).** `upgradeAllowed: true` and `cutoffFormatScore: 300` are already set, and an English grab scores 150 — below cutoff, therefore already *eligible*. It simply has never been triggered. A one-off cutoff-unmet search converts a correct-but-dormant config into actual upgrades, which is exactly the "prefer + upgrade" policy the user chose.
- **Fix credentials as an isolated slice (Slice 1)** so it can be reviewed, landed and reverted independently — and so nobody later mistakes it for the audio fix.
- **Measure with the same method that produced the diagnosis (Slice 4).** The Jellyfin `MediaStreams` audit is what turned "it feels like it's in English" into "0/4 series". Making it a script means the next person gets a number, not a hunch.

## 4. Decisions

### Decision 1 — How to obtain a Spanish source pool. **BLOCKED — needs user GO.**

**Context.** Prowlarr ships 626 indexer definitions; 15 are Spanish. The only *public* one carrying film/TV is `Elitetorrent-wf`, which is **already enabled** and is **es-ES (castellano), not Latin-American**. Searching all 626 definitions by name for `DonTorrent`, `MejorTorrent`, `DivxTotal`, `Wolfmax4K`, `EstrenosGO`, `Todotorrents`, `Torrentrapid`, `AtomixHQ`, `GranTorrent`, `Cinecalidad` returned **zero hits**. Every remaining Spanish option is private.

This is why the change cannot proceed as a config tweak.

| Option | What it buys | Cost / risk |
|---|---|---|
| **1a. Join a private Spanish tracker** — `Lat-Team` (es-MX) is the canonical Latin-American one; `HD-Olimpo`, `Torrenteros`, `HDZero` for castellano | The real fix. Private trackers are where Spanish TV lives, with consistent tagging and seeders | Requires account/invite and ratio upkeep. Human action, not automatable. Gated on availability of open signups |
| **1b. Add custom Cardigann definitions** for public Spanish sites Prowlarr does not ship | No gatekeeping, lands immediately | Unofficial YAML the user maintains; breaks silently when a site changes markup. Must verify this Prowlarr build loads `/config/Definitions/Custom` |
| **1c. Both — 1b now, 1a when a signup opens** | Immediate improvement plus a durable path | Two mechanisms to maintain |
| **1d. Do nothing upstream** | — | Slices 1, 2, 4 and 5 still run. The custom-format repair (Slice 5) genuinely helps on `MULTi` releases that generic trackers already carry, so the audio number can move a little — but series stay at 0 until a Spanish TV source exists |

**Recommendation: 1c.** 1b delivers value this week without depending on a stranger opening registrations, and 1a is the only durable answer for series. Doing 1a alone risks the change stalling indefinitely on an invite; doing 1b alone leaves TV weak, which is precisely the 0/4 case.

**Not decided here.** Apply must not start on Slice 2 until the user picks.

### Decision 2 — Prefer + auto-upgrade, do not hard-require Spanish. **GO (user decision).**
**Verdict:** Keep `minFormatScore = 0`. Rely on `upgradeAllowed: true` + `cutoffFormatScore: 300` so an English grab (score 150, below cutoff) is later replaced when a Spanish release appears.
**Rationale:** The evidence supports it — scoring already works where sources exist (4/7 movies). The gap is availability, and a hard requirement punishes availability gaps by producing nothing at all.
**Tradeoffs:** Some titles sit in English for a while; upgrades cost re-download bandwidth and disk churn.
**Rejected alternative:** `minFormatScore > 0` / reject-English. Guarantees language but, on the observed sample, would have blocked 3/7 movies and every single series. A library with holes is worse than a library with subtitles-later.

### Decision 3 — Add two custom formats; do not re-tune the existing ones. **GO.**

> Supersedes an earlier draft of this decision that said "change nothing". That draft was wrong: it was written from reading the config, and the config reads correct. Measuring it via `GET /api/v3/parse` on both services showed it is not.

**Verdict:** Leave the existing weights (300/150/80/50) alone. **Add** two formats on profile `id 6`, on both Radarr and Sonarr:

1. **`MULTi`** — a `ReleaseTitleSpecification` for `\bmulti\b`, scored in the `Dual` band (~150). Measured today: `MULTi` matches nothing and scores **0**, identical to an untagged English release — yet `Avatar - Fire and Ash`, one of only four movies that actually landed Spanish audio, is a `MULTi` release. The most productive marker in the real library is invisible to the scorer.
2. **`Lang: Spanish (Latino)`** — a `LanguageSpecification` for the `Spanish (Latino)` language id, so latino finally outranks castellano. Measured today both score **380**: `Latino +300` fires only for latino, `Lang: Spanish +300` fires only for castellano, and they cancel exactly. The `Latino` format creates the *appearance* of a preference that does not exist.

**Rationale:** Both are additive coverage gaps, not balance problems, and both are fixable today without any new tracker — which makes this the only slice not gated on Decision 1. Defect 2 matters specifically here: the user is Argentine and wants latino, while the single Spanish tracker currently enabled is es-ES castellano.

**Tradeoffs:** Scoring `MULTi` promotes releases that are larger (many audio tracks) and whose Spanish track is not guaranteed to be latino. Accepted — a Spanish track of some flavour beats none, and §1 shows `MULTi` empirically delivering.

**Verification:** re-run `/api/v3/parse` on the same title set afterwards and confirm `MULTi` > 0 and latino > castellano. The before-numbers are recorded in `explore.md` §2.1, so this is a diff, not an opinion.

**Rejected alternative:** raising `Latino` to +600 instead of adding the language format. Same ranking, but it keeps the misleading structure where the latino signal comes only from a title regex — and it would break the moment a release is tagged `LATAM` in metadata but not in the title.

### Decision 4 — Fix the BFF keys, but keep them out of the audio narrative. **GO.**
**Verdict:** Repair `infra/.env` from each service's own `config.xml` and recreate `bff`, as an independently reviewable slice.
**Rationale:** The 401 is real and reproducible (broken key → 401, real key → 200, all three services). But Jellyseerr — the actual requester — holds correct keys and bypasses the BFF entirely, so this cannot affect which release is grabbed. Bundling it with the audio work would relitigate the wrong hypothesis every time someone reads the diff.
**Tradeoffs:** The `bff` image is baked, so this needs `docker compose up -d --build bff`, i.e. a container recreate rather than a hot overlay.

### Decision 5 — Measure with Jellyfin `MediaStreams`, not with *arr history. **GO.**
**Verdict:** The audit reads audio-track languages per library item from Jellyfin.
**Rationale:** *arr history records what was *grabbed* and how it was *scored* — including its own guess at language. `MediaStreams` reports what is actually in the file. Those disagree exactly in the failure mode being fixed (e.g. `Hoppers` landed `und`, `Mr. Robot` landed an untagged English track), so the file is the only trustworthy source.
**Tradeoffs:** Depends on Jellyfin having probed the file; freshly imported items may lag a scan.
**Rejected alternative:** Trusting Radarr/Sonarr's parsed `languages[]` — that is the layer under suspicion.

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Decision 1 never unblocks (no tracker access) | The audio outcome does not improve at all | Slices 1, 3, 4 still land and are independently useful; the audit makes the "no sources" conclusion undeniable rather than arguable |
| Upgrade sweep floods qBittorrent / saturates the link | Everything else stalls | Run the sweep scoped (Radarr first, then Sonarr), off-peak, and watch the queue before widening |
| Upgrades churn disk by replacing large remuxes | Storage pressure on `/media/data1`,`/media/data2` | Check free space before the sweep; the audit records file sizes for before/after |
| A custom Cardigann definition (1b) breaks silently | Silent regression to today's behaviour | The audit is the detector — re-run it on a schedule, not once |
| Recreating `bff` drops something else the hand-built `.env` was carrying | BFF breaks in a new way | Diff the rebuilt `.env` against the running container env before recreating; keep the current file as a backup |

## 6. Success criteria

1. `infra/.env` keys return **200** against Radarr, Sonarr and Prowlarr from inside the `bff` container.
2. The audit script runs and reports a **baseline Spanish-audio ratio** for the current library (expected to reproduce ≈4/7 movies, 0/4 series).
3. `GET /api/v3/parse` on the `explore.md` §2.1 title set shows, on **both** services: `MULTi` scoring above 0, and latino scoring strictly above castellano. Not gated on Decision 1.
4. At least one **Spanish-language TV source** is enabled and proven to return Spanish-marked TV results (Decision 1 dependent).
5. A cutoff-unmet sweep has run and Radarr/Sonarr report the number of items eligible for upgrade.
6. Re-running the audit after the sweep shows a **strictly higher** Spanish-audio ratio, or a documented explanation of why it did not.
7. The apply report states plainly which slices moved the audio number and which did not — the credential fix in particular must not be credited with an audio improvement.
