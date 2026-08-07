# Handoff — mobile music overhaul, 2026-08-07

Written at the end of a long session so the next agent starts from evidence
rather than from scratch. Read this before touching anything.

Full narrative, design docs and prior exploration live in engram under
`sdd/mobile-music-overhaul/*` — start with `traspaso`, then
`diagnostico-consolidado`. Working-practice lessons from this session are in
`~/.claude/projects/-home-alexis-Documentos-poisonflix-web/memory/`.

---

## 1. The open bug the owner cares about most

**Every "Porque escuchaste X" row shows the same five tracks.**

- `evidence/owner-01-identical-rows.png` — four rows (SNAK THE RIPPER, Risa
  Express, Doble Porción, plus "Mix para vos") serving an identical list:
  Jealous / Eyedress · Mi Comedia / Métricas Frías · Something About… /
  Eyedress · Babydoll / Dominic Fike · It's All I… / Eyedress.
- `evidence/owner-02-identical-rows-scrolled.png` — same, further down. The
  rows are seeded by rap artists and answered with indie / bedroom pop.

### What is proven

The worker was mixing three **user-scoped** sources into every radio
(`_src_your_artists`, `_src_your_likes`, `_src_history`), so the seed only
influenced part of the result. Running the worker's real `_interleave` with
three different seeds put **50% of the tracks in identical positions**. The
frontend deduped rows by exact tracklist signature, which therefore never
matched — the lists differed just enough.

A `pure=True` mode now restricts a seeded radio to `_src_seed` + `_src_related`
and excludes the seed's own videoId. Measured against the deployed worker:

| pair | overlap |
|---|---|
| Alcolirykoz vs Tame Impala | 0/24 = 0% |
| Alcolirykoz vs Doble Porción | 1/23 = 4% |
| Tame Impala vs Doble Porción | 0/24 = 0% |

Genre coherence came back too: rap seeds return rap (Violadores Del Verso,
Granuja, Métricas Frías), psych-rock returns indie/alt (Dominic Fike, Ravyn
Lenae, The Weeknd).

### Why it is still open

**That measurement used `docker exec` straight into the worker. The path the
owner actually uses — browser → BFF → worker, with his session — was never
verified.** He still sees identical rows.

Two theories are already **dead**, do not spend time on them:

- *Service worker serving a stale bundle.* The owner reproduced it in a private
  window. (A self-destroying SW was shipped anyway; it is correct hardening but
  it is not this bug.)
- *Browser HTTP cache.* Same reason.

Where to look next, in order:

1. Watch the real request from the browser and confirm `pure=1` survives all
   the way to the worker. The BFF's `handleMusic` forwards the query string
   verbatim — verify that in flight, not by reading it.
2. `@tanstack/react-query` holds seeded radios at `staleTime: 30 * 60_000`. New
   keys should sidestep it; confirm.
3. The worker's own cache key includes `pure` in the source — confirm at
   runtime.
4. Check whether these rows even come from `usePersonalMusicFeed`, or from
   another path nobody has read yet.

**Reproduce it before believing any new theory.** Three confident diagnoses
died this session; the ones that survived were measured.

---

## 2. Second open bug

**"Tus me gusta" renders raw videoIds** (`N-iWzk2_fOM`, `J3DWAJGaf7o`) with
"Desconocido" as the artist and no artwork.

The worker returns `{"ratings": {}, "liked": []}` — the server holds **zero**
ratings and `/data/ratings.json` does not exist. What the owner sees is client
cache. All three `rate()` call sites do pass title/artist/thumbnailUrl, so new
likes should store cleanly; find out why nothing persists, then backfill the
old rows via `get_song`.

---

## 3. Shipped and verified

- **Radio unbroken.** `ytmusicapi` 1.8.2 → 1.12.1; the old pin raised
  `KeyError: 'endpoint'` on every `get_watch_playlist`, so the radio's main
  source had been throwing for weeks and silently replaying the listener's own
  history. Live: 20 tracks / 12 distinct artists / no consecutive repeats.
- **Auto-advance while locked.** `ended`/`error` now call `play()` synchronously
  through `runGesture` instead of leaving it to a passive effect — React
  schedules those on a MessageChannel and a suspended page never runs them. An
  on-device probe measured 84s frozen with no audio playing vs 3s of throttling
  while audio was. Verified red-before-green; **not yet confirmed on the
  owner's phone.**
- **Lock-screen controls.** Dropped `seekbackward`/`seekforward` (iOS was
  displacing next/prev with them), added `stop`, and `setPositionState` now
  reports `playbackRate: 0` on pause/waiting/stalled so the scrubber stops
  counting through silence.
- **Overlay dismissal.** `OverlayShell` + `overlayStack`, all eight migrated.
  Verified in a real browser at 390×844: tapping an item navigates
  (`/musica` → `/downloads`), tapping outside closes without navigating.
  `evidence/agent-02-mobile-menu-open.png`.
- **Worker audio integrity.** No more serving fragmented bytes on a failed
  remux, real `ffprobe` validation, Opus transcoded to AAC with a
  duration-proportional timeout, 67 tests where there were none, plus a Python
  CI job.
- **Compose.** `JELLYFIN_URL` / `JELLYFIN_API_KEY` now reach the worker — they
  never did, so every Jellyfin call 401'd and no library track could resolve to
  a seed. `DATA_DIR` fails loudly instead of interpolating blank.

---

## 4. Environment facts that change what is worth building

- **Jellyfin holds 0 audio tracks.** `/home/alexis/jellyfin-server/media/Music`
  is empty. The owner streams only and said downloads are the least of his
  concerns ("si es necesario limpia todas las descargas").
- The personalised feed was therefore reseeded from `/plays` (the worker's
  preview tally), which is **also empty right now** and refills as he listens.
- Test login is in the memory file `poisonflix-login-for-visual-checks.md`.

---

## 5. Jam — deferred by the owner, plan it before building it

There is **no realtime infrastructure at all** (zero WebSocket/SSE).
`src/features/remote/` is not reusable: a one-way relay to an Android TV polled
every 15s, no session, no broadcast. The BFF is single-instance Node 22 with no
dependencies and flat-JSON persistence. Player state lives entirely in the
client.

Three product decisions come before any design (detail in
`sdd/mobile-music-overhaul/decision-jam-ultimo`):

1. Authoritative host, or shared control? Changes the data model.
2. Shared queue only, or synchronised playhead? The second means clock sync
   with drift compensation over a home network — far more expensive, and worth
   little unless listeners are in the same room.
3. Transport follows from (2): SSE is enough for a shared queue; a synchronised
   playhead needs a bidirectional channel and an authoritative clock.

---

## 6. Traps in this terrain (each one cost real time)

- **The Bash working directory persists between calls.** A stale
  `cd infra/music-worker` made a later `tsc` run where no tsconfig exists.
- **In a pipeline `$?` belongs to the last command.** `cmd | tail && echo OK`
  lies. `deploy.sh` did exactly this and reported a public deploy nobody had
  verified.
- **`agent-browser`**: `set viewport W H` (not `resize`); `close --all` before
  changing `--headed`/`--args`; reopening loses the session; **screenshots
  capture the viewport only — scroll before concluding anything.** Not scrolling
  is how the music page got declared healthy while the broken rows sat below
  the fold: `evidence/agent-01-music-top-viewport-only.png`.
- **`fireEvent`/`userEvent` wrap in `act()` and flush effects**, so a test meant
  to prove a call is synchronous passes against the deferred code too.
  Dispatching the DOM event directly is what separates them.
- **Always confirm a test is RED before implementing.** Two adversarial rounds
  found ten blockers no suite could see — including a validator that deleted
  every downloaded file, a backdrop covering the mobile menu, and a portalled
  menu falling outside the fullscreen subtree.
- **The owner does not review the PR.** Adversarial review before committing is
  not optional here.
