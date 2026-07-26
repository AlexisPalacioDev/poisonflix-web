# Exploration: spanish-audio-downloads

Change: `spanish-audio-downloads`
Date: 2026-07-26
Scope decided with the user before investigating: **AUDIO only**. Subtitles (Bazarr) are explicitly out of scope.
Method: read-only live diagnosis on `mendezserver` + read-only code trace of `poisonflix-web@feat/projector-web-integration`. Nothing was modified.

## 0. The question

Movies and series are not being downloaded with Spanish audio. Why?

Two competing explanations had to be separated before anything else:

- **Selection problem** — the Spanish audio track never lands in the file, because the release that was grabbed does not contain one.
- **Perception problem** — the Spanish track is in the file, but Jellyfin or the app does not surface or select it.

These have completely different fixes, so the empirical check came first.

## 1. Ground truth — what audio actually landed

Source: Jellyfin `/Users/{userId}/Items/{id}?Fields=MediaStreams`, 7 movies + 5 episodes.

| Title (release group) | Audio streams | Spanish? |
|---|---|---|
| Avatar - Fire and Ash (`MULTi.DTS-HD.MA`) | eng, eng, **spa DDP7.1**, **spa DD5.1**, fra, deu, ita, rus | yes |
| Balls Up (`Dual`) | **spa (Latin America, default)**, eng | yes |
| Demon Slayer Infinity Castle (`Dual-YG`) | **spa (default)**, jpn | yes |
| Inception (`REMUX-FGT`) | eng, fra, **spa DD5.1**, por | yes |
| The Drama (`TrueHD7.1-DreamHD`) | eng ×4 | no |
| Hoppers (`BluRay 5.1-LAMA`, UIndex) | und/AAC only | no |
| Memento (`BDRemux MaLLIeHbKa`) | rus, eng | no |
| Punisher S01E01 (`NF.WEB-DL-NTb`) | eng | no |
| Severance S01E01 (`WEBRip-RARBG[eztv.re]`) | eng | no |
| Mr. Robot S01E01 (`BluRay HEVC-PSA`) | eng (undefined tag) | no |
| Solo Leveling S01E01 (`TrueHD`) | eng (default), jpn | no |

**Conclusion: this is a SELECTION problem, not a perception problem.** The Spanish tracks are genuinely absent from the files.

Two distinct signals inside that result:

- **Movies: 4/7 have Spanish.** They succeed exactly when the grabbed release was tagged `MULTi` / `Dual`, or is an older catalog title distributed as a many-track remux.
- **Series: 0/4 (0/5 counting the anime).** Every grabbed episode came from an English-language scene group (NTb, RARBG/eztv, PSA) — i.e. from English-only indexers.

## 2. Radarr / Sonarr configuration — right idea, three real defects

Language preference **was** configured — this is not a "nobody set it up" case. But measuring it instead of reading it turned up three concrete defects.

Versions: **Radarr 6.3.0.10514**, **Sonarr 4.0.19.2979** (v4 — language profiles removed, custom formats only). Both share profile `id 6` `"HD - 720p/1080p"`, the one Jellyseerr uses for movies, series and anime.

```
minFormatScore = 0   cutoffFormatScore = 300   minUpgradeFormatScore = 1   upgradeAllowed = true
cutoff = 1002 (quality)   Radarr profile language = {id:-1,"Any"}   |  key absent on Sonarr (v4)

Lang: Spanish   +300   LanguageSpecification value=3  (Spanish)
Latino          +300   ReleaseTitleSpecification  \b(latino|latam)\b
Dual            +150   ReleaseTitleSpecification  \b(dual([.\s_-]?audio)?|esp[.\s_-]?eng|...)\b
Lang: English   +150   LanguageSpecification value=1  (English)
Espanol          +80   ReleaseTitleSpecification  \b(latino|castellano|espa[nñ]ol|spanish)\b
Lang: Japanese   +50   LanguageSpecification value=8
Bad Source / AV1  -10000 (reject)
```

### 2.1 Measured, not assumed

`GET /api/v3/parse?title=...` on both services reports which formats a title actually matches. Summed against the profile scores:

| Release marker | Parsed language | Formats matched | **Score** |
|---|---|---|---|
| `Latino` | `Spanish (Latino)` | Espanol, Latino | **380** |
| `Castellano` | `Spanish` | Espanol, `Lang: Spanish` | **380** |
| `Spanish` | `Spanish` | Espanol, `Lang: Spanish` | **380** |
| `Latino` + `Dual` | `Spanish (Latino)` | Dual, Espanol, Latino | **530** |
| `Dual` | `Unknown` | Dual | **150** |
| `MULTi` | `Unknown` | — | **0** |
| untagged (English scene) | `Unknown` | — | **0** |

Identical on Radarr and Sonarr. `/parse` scores from the title alone — which is representative here, because Prowlarr does not populate the structured `languages` field, so the title is effectively all the *arr services ever get.

### 2.2 Defect A — `MULTi` scores 0

There is **no `MULTi` custom format**, and the `Dual` regex does not cover it (`multi` is absent from the alternation). Measured: `MULTi` matches nothing and scores 0 — same as an untagged English release.

This is not academic. `Avatar - Fire and Ash` is one of the four movies in §1 that *did* land Spanish audio, and it landed as a `MULTi` release. **The marker most responsible for Spanish audio actually arriving is worth nothing to the scorer.** It got through by luck, not by preference.

### 2.3 Defect B — latino does not outrank castellano

Both score **380**. The intent is visibly there (`Latino +300` exists as its own format) but it is cancelled by accident: Radarr/Sonarr parse `Latino` as the language **`Spanish (Latino)`**, a *different* language id from `Spanish` (id 3). So `Lang: Spanish +300` fires for castellano and **not** for latino, exactly offsetting the `Latino +300` that fires for latino and not for castellano. 380 either way.

Nothing in the config expresses "prefer Latin-American Spanish" in effect — only in appearance. There is no `Lang: Spanish (Latino)` format.

### 2.4 Defect C — `Lang: English +150` rarely fires

An untagged English scene release parses as `Unknown`, not `English`, so it scores **0**, not 150. The direction is unaffected (Spanish still outranks it), but any reasoning that treats 150 as the English baseline is using a number that does not occur in practice.

**Finding: Spanish > English holds, but the latino preference is inert and the highest-yield marker in the actual library (`MULTi`) is unscored. Both are cheap, contained fixes — and both were invisible until the scores were measured rather than read.**

Secondary, real but not root: `minFormatScore = 0` means Spanish is *preferred*, never *required* — an untagged English release at score 0 is fully acceptable and gets grabbed when it is the best candidate found.

## 3. The actual bottleneck — the indexer pool

Prowlarr, 23 configured / **21 enabled** (`1337x` and `Internet Archive` disabled):

```
Elitetorrent-wf   enabled   <-- the ONLY Spanish-oriented tracker (es-ES / castellano)
EZTV, The Pirate Bay, LimeTorrents, YTS, Knaben, TorrentsCSV,
Torrent Downloads, TorrentDownload, U3C3                       general / English-biased
Nyaa.si, sukebei.nyaa.si, Shana Project, SubsPlease,
Tokyo Toshokan, OneJAV                                          anime / JP
E-Hentai, PornoTorrent, PornRips, XXXClub, xxxtor              adult (7 of 21 slots, with OneJAV + sukebei)
1337x, Internet Archive                                         disabled
```

That single line explains the whole split in §1. Big-name movies occasionally circulate as `MULTi`/`Dual` even on generic English trackers, so movies land Spanish 4/7 by luck — and per §2.2 that luck is not even helped by the scoring, since `MULTi` is worth 0. **There is no Spanish TV tracker in the pool at all**, so series land Spanish 0/4 — deterministically, not by chance.

### 3.1 And the pool cannot simply be widened

Queried Prowlarr's full definition catalog (`GET /api/v1/indexer/schema`): **626 definitions, 15 tagged Spanish.**

| Definition | Language | Privacy | Useful for film/TV |
|---|---|---|---|
| Elitetorrent-wf | es-ES | **public** | yes — already enabled |
| GamesTorrents | es-ES | public | no (games only) |
| Union Fansub | es-ES | semiPrivate | partial |
| Lat-Team (API) | **es-MX** | private | yes — the canonical latino tracker |
| HD-Olimpo, HDZero, Torrenteros, ParabellumHD, Milnueve, NOBS, PuntoTorrent, eMuwarez | es-ES | private | yes |
| BTArg (es-AR), ChileBT (es-CL), F1Carreras (es-MX) | — | private | partial |

Searched the catalog by name for the well-known public Spanish sites — `DonTorrent`, `MejorTorrent`, `DivxTotal`, `Wolfmax4K`, `EstrenosGO`, `Todotorrents`, `Torrentrapid`, `AtomixHQ`, `GranTorrent`, `Cinecalidad`: **zero hits**. The only name-match across all 626 definitions was `Lat-Team`.

**Finding: the only public Spanish tracker Prowlarr ships that carries film/TV is already enabled. Every remaining Spanish source is private (account or invite required). This is the crux of the change — it is not a config toggle.**

## 4. Code side — no language preference ever leaves the app

Traced on the server repo (source of truth), not the stale local clone.

- `src/lib/domain/releaseLanguage.ts` — `detectLanguages(title)` classifies `multi | spanish-latino | spanish-castellano | spanish | french | italian | portuguese | english`, defaulting to `english` when unmarked (`:75`). It is a pure title-string classifier taking no request context.
- Its **only** consumers are `availability.ts:36-73` (`summarizeAvailability` rolls up counts/seeders per language) and `AvailabilityPanel.tsx:51-59`, which renders read-only chips. No click handler, no selection state, no callback into the request path.
- `requestMedia()` (`src/api/jellyseerr.ts:160-171`) POSTs to Jellyseerr `/api/v1/request` with a body of exactly `{ mediaType, mediaId }` (+ `seasons: 'all'` for TV). No `language`, no `qualityProfileId`, no tags. `RequestMediaParams` does not even accept such a field.
- `infra/bff/server.mjs:137-160` — the allowlist exposes reads only (`radarr` queue/movie, `sonarr` queue/series/episode, `prowlarr` search) plus one `POST prowlarr /api/v1/search` grab. **There is no Radarr/Sonarr add-with-profile route at all.**
- `useLanguage` / `languageSettings.ts` is a **UI-only** ES⇄EN toggle: it maps `'es' → 'es-MX'` onto TMDB's `language` query param for metadata text (`languageSettings.ts:61-63`), persisted at `localStorage['poisonflix:language']`, consumed by `Header.tsx:32`. **It has no path to Radarr/Sonarr and never expresses an audio preference.** This is an easy thing to mistake for the language control; it is not.
- Tests: `releaseLanguage.test.ts` and `availability.test.ts` cover the pure functions. No test touches `requestMedia` with a language parameter — because no such code path exists.

**Finding: the app displays which languages exist, then requests without telling anyone. Language selection is delegated entirely to Jellyseerr's server-side default profile (id 6), which is outside this repo.**

## 5. The API-key 401 — a real bug, and a red herring for this problem

```
config.xml (truth, read from inside each container)
  radarr   09e008cb52bd4ba989d77ca981617891
  sonarr   0f30689ffe80409687d1006ede15cd49
  prowlarr 3891afca05564728ad5245314f600041

infra/.env  ==  bff container env   (identical to each other, both WRONG)
  RADARR_API_KEY=e0f226bf8aa4429ea6eceaacc127ba22
  SONARR_API_KEY=ce4b94fd36714d289c1bc4833e8d050d
  PROWLARR_API_KEY=4c1e3f4f82c54f8ebbe8c51d84a74417

curl :7878 /api/v3/system/status   broken key -> 401   real key -> 200
curl :8989 /api/v3/system/status   broken key -> 401   real key -> 200
curl :9696 /api/v1/system/status   broken key -> 401   real key -> 200
```

Confirmed: `infra/.env` was hand-reconstructed in an earlier session and the keys it carries are fabricated.

**But Jellyseerr does not go through the BFF.** Its own `/app/config/settings.json` holds `radarr[0].apiKey = 09e008…` and `sonarr[0].apiKey = 0f3068…` — the correct ones — and talks to both services directly (`hostname: radarr/sonarr`, `activeProfileId: 6`, `activeDirectory: /data/media/Movies` and `/data/media/Shows`, `isDefault: true`, no 4K or per-request override).

**Finding: the BFF's broken keys break the BFF's own reads (queue, library views) and must be fixed — but they are NOT in the request→grab path, so fixing them changes zero audio tracks.** The leading hypothesis going into this investigation was wrong.

## 6. Root causes, ranked

1. **The indexer pool has effectively no Spanish source, and none can be added without joining a private tracker (§3, §3.1).** Dominant cause. Directly predicts the 4/7 movies vs 0/4 series split in §1.
2. **`MULTi` is unscored (§2.2).** Cheap to fix, and it targets the exact marker that delivered Spanish audio in the one movie case that demonstrably worked. Independent of cause 1 — this one can be fixed today, without any new tracker.
3. **The latino preference is inert (§2.3).** `Latino +300` and `Lang: Spanish +300` cancel out at 380 each because `Latino` parses as `Spanish (Latino)`, a different language id. Matters for an Argentine user who wants latino, not castellano — and the one enabled Spanish tracker is es-ES castellano.
4. **`minFormatScore = 0` — Spanish is preferred, never required (§2).** Contributing, and deliberately kept (user policy: never leave a hole in the library).
5. **No upgrade sweep has ever run over the existing library (§2).** `upgradeAllowed: true`, `cutoffFormatScore: 300`, `minUpgradeFormatScore: 1` are set, and an untagged English grab scores 0 — far below cutoff, therefore *eligible* — but Radarr/Sonarr only act on that via RSS sync or an explicit cutoff-unmet search. The already-English library will not self-heal without a trigger.
6. **BFF `infra/.env` keys are wrong (§5).** Real bug, unrelated to audio.
7. **Content scarcity for specific titles (§1).** Memento had only a Russian scene remux available; not a config fault.

## 7. What was deliberately not investigated

- Bazarr / subtitles — out of scope by explicit user decision.
- Whether the 8 adult indexers slow every search enough to matter (suspected, unmeasured).
- Whether Jellyfin picks the right default audio track for playback — moot while the tracks are absent, relevant again once §6.1 is fixed.
