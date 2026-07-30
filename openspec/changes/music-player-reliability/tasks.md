# Tasks: Music Player Reliability

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~560 (~160 source, ~400 test) |
| 400-line budget risk | Medium (over the 400-line reviewer guideline, but comfortably under the 800-line project budget) |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | single-pr-default |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

Note: my file-level breakdown below lands close to the design's own ~560-line forecast — not materially higher. It stays under the stated 800-line budget, so it is kept as one PR rather than split; only 4 independent slices exist and none benefits from an isolated review pass.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Reducer core: `SYNC_MEDIA`, `BUFFERING_SETTLE_MS`, `durationMismatch()` | PR 1 (single) | `npx vitest run musicPlayerCore.media.test.ts` | N/A — pure functions, fully covered by vitest | `musicPlayerCore.ts` + its test file, revert independently |
| 2 | Provider wiring: event handlers, probe suppression, settle timer, diagnostics dispatch | PR 1 (single) | `npx vitest run MusicPlayerProvider.media.test.tsx` | Manual on a real iOS/Safari device: play/pause/stall a track, watch for stuck spinner or probe-triggered pause | `MusicPlayerProvider.tsx` handler block, revert independently of Unit 1 |
| 3 | `'full'` ThumbButtons variant + FullPlayer wiring + buffering-aware ToggleButton | PR 1 (single) | `npx vitest run ThumbButtons.test.tsx NowPlayingBar.test.tsx` | Manual on a real phone viewport: confirm 44x44 tap target and layout fit | `ThumbButtons.tsx`, `thumbs.css`, `NowPlayingBar.tsx`/`.css` full-player hunk, revert independently |
| 4 | Worker `STREAM_URL_TTL` bump | PR 1 (single) | N/A — no Python suite | `cd infra && docker compose up -d --build music-worker`, two timed `/stream` requests >300s apart, confirm no re-resolve in logs | `infra/music-worker/server.py:75`, one-line revert to `300.0` |

## Phase 1: Reducer Core (Foundation)

- [x] 1.1 RED: create `src/features/music/musicPlayerCore.media.test.ts`. Assert `SYNC_MEDIA` reducer transitions: `{ playing: true }` sets `isPlaying=true`; `{ buffering: true }` sets `buffering=true` without touching `isPlaying`; a no-op patch (fields already match current state) returns the SAME state reference (identity-return, assert with `toBe`, not `toEqual`).
- [x] 1.2 GREEN: add `SYNC_MEDIA { playing?: boolean; buffering?: boolean }` to the `Action` union and reducer switch in `src/features/music/musicPlayerCore.ts`. Add `buffering: boolean` to `PlayerState`, initialized `false` in `initialState`. Implement the reducer branch: merge only provided fields, return `state` unchanged when the merge is a no-op.
- [x] 1.3 RED (in same test file): assert `state.buffering` exposed via context equals `false` whenever `state.isPlaying` is `false`, even if the raw reducer field is `true` — the `buffering && isPlaying` derivation, tested at the selector/context-value level, not by resetting the reducer field on every track-change branch.
- [x] 1.4 GREEN: export `BUFFERING_SETTLE_MS = 600` from `musicPlayerCore.ts`. Wire the context's exposed `buffering` field as `state.buffering && state.isPlaying` (do not touch any of the 11 existing track-change reducer branches). Implemented as an exported pure `visibleBuffering(state)` selector, wired into `MusicPlayerContextValue` in Phase 2 (deferred from Phase 1 to keep `tsc -b` green — see Deviations).
- [x] 1.5 RED (same file): assert `durationMismatch(elementDuration, trackDuration)` — true when `|el - known| > max(2, known * 0.05)` and both finite/positive; false when either is non-finite, zero, negative, undefined, or null; false exactly at the tolerance boundary; true just past it. Cover the 2s-floor case (short track, e.g. known=10s) and the 5%-band case (known=200s).
- [x] 1.6 GREEN: implement and export pure `durationMismatch(elementDuration: number, trackDuration?: number | null): boolean` in `musicPlayerCore.ts`.
- [x] 1.7 Verify: `npx vitest run musicPlayerCore.media.test.ts` green; `npx tsc -b` exit 0.

## Phase 2: Provider Wiring — Reconciliation, Probe, Buffering (Core Implementation)

Requirement: `music-playback-state` (Playing State Reconciliation, Unlock Probe Suppression, Buffering Distinct From Paused). Superseded spec detail: the spec's provisional 250ms buffering settle window is overridden by design's asymmetric 600ms-assert/immediate-clear hysteresis (Phase 1.4) — this task wires that decision, it does not re-litigate it.

- [x] 2.1 RED: create `src/features/music/MusicPlayerProvider.media.test.tsx`. Assert external pause reconciles: given `isPlaying=true`, `fireEvent.pause(audioEl())` drives `state.isPlaying` to `false`. Assert `play`/`playing` events drive `isPlaying` to `true` from a `false` start. jsdom-asserted via synthetic events dispatched at the element.
- [x] 2.2 GREEN: in `MusicPlayerProvider.tsx`, attach `play`/`playing`/`pause` element listeners that dispatch `SYNC_MEDIA` per the design's event table (`play` → `{playing:true}`; `playing` → `{playing:true, buffering:false}`; `pause` → `{playing:false, buffering:false}`).
- [x] 2.3 RED (same file): assert Safari `ended`-then-`pause` does not cancel the `NEXT` auto-advance — set `Object.defineProperty(audio, 'ended', {value: true})`, fire `ended` then `pause`, assert the queue still advances (no spurious `isPlaying=false` short-circuit of the auto-advance path). jsdom-asserted via defined `ended` property + synthetic events.
- [x] 2.4 GREEN: guard the `pause` handler with `if (probeRef.current || audio.ended) return;` before dispatching.
- [x] 2.5 RED (same file): assert probe suppression — trigger the existing unlock-probe path (first gesture, `!isPlaying`), assert `isPlaying` does not flip as a direct result of the probe's own `play()`→`pause()`. jsdom-asserted: drive the probe's promise resolution and its resulting synthetic `play`/`pause` events; explicitly NOT assertable is `unlockedRef.current` transitioning (never exposed to a test-observable surface) nor real iOS promise-ordering — documented plainly in the test file rather than claimed as coverage. See Deviations.
- [x] 2.6 GREEN: introduce `probeRef = useRef(false)`. At the existing `p.then(() => audio.pause())` unlock probe, set `probeRef.current = true` synchronously BEFORE calling `audio.play()`. On promise resolution: if `stateRef.current.isPlaying` is true, set `probeRef.current = false` and return (user won the race); otherwise call `audio.pause()` and let the `pause` event handler (2.4) close the window. On rejection, set `probeRef.current = false`. Added a `window.setTimeout(() => { probeRef.current = false; }, 3000)` belt timer. Did NOT close the window in `.finally()`.
- [x] 2.7 RED (same file): assert stall does not report as paused — given `isPlaying=true`, `fireEvent.waiting(audioEl())` (or `stalled`) leaves `isPlaying` `true` and eventually sets `buffering` `true`; assert `playing` clears `buffering` immediately.
- [x] 2.8 GREEN: attach `waiting`/`stalled` listeners that arm a `bufferingTimerRef` timeout of `BUFFERING_SETTLE_MS` (600ms) dispatching `SYNC_MEDIA { buffering: true }`; attach `playing` and `canplay` listeners that clear the timer and dispatch `SYNC_MEDIA { buffering: false }` immediately. Cleared `bufferingTimerRef` on unmount.
- [x] 2.9 RED (same file): using `vi.useFakeTimers()`, assert buffering stays `false` at 599ms after a `waiting` event and becomes `true` at 600ms; assert immediate clear on `playing` with no delay; triangulated with a `stalled`-event and a `canplay`-clear variant.
- [x] 2.10 Verify: `npx vitest run MusicPlayerProvider.media.test.tsx` green (14/14); `npx tsc -b` and `npx oxlint` exit 0; full suite `npx vitest run` stayed green throughout (74 files / 560 tests at Phase 6).

## Phase 3: Diagnostics (Security-Sensitive)

Requirement: `music-playback-diagnostics` (Duration Mismatch Reporting, No Corrective Behavior). Threat-matrix case: data exposure in logs — the diagnostic payload must never contain `src`, which embeds the Jellyfin `api_key` (confirmed at `src/lib/domain/streamResolver.ts:70-73`).

- [x] 3.1 RED (security, in `MusicPlayerProvider.media.test.tsx`): fire `durationchange` with a mismatched duration, then call `recordedFailures()` from `src/lib/obs/report.ts` and assert NO recorded failure's `detail` (stringified) contains the substring `api_key` or the raw `src`/stream URL. Called `clearRecordedFailures()` in `beforeEach`. Also asserts a sanity check that the real `src` DOES contain `api_key` (proves the test would actually catch a leak).
- [x] 3.2 GREEN: attached `durationchange` and `ended` listeners that call `durationMismatch(audio.duration, current?.durationSeconds)`; on true, call `reportFailure('music.player.durationMismatch', ..., { elementDuration, trackDuration, currentTime, readyState, seekableEnd, bufferedEnd, event, itemId, videoId })` — explicitly excluding `src`. Reads `seekable.end()`/`buffered.end()` through a null-returning `timeRangeEnd()` guard (both throw on an empty `TimeRanges`, exercised directly by jsdom's empty default ranges and asserted in a dedicated test).
- [x] 3.3 RED (same file): assert exactly one report per track load — fire `durationchange` twice for the same track, assert `recordedFailures()` grew by 1, not 2.
- [x] 3.4 GREEN: added `durationReportedRef` holding the last-reported track key (`itemId`); reset to `null` in the existing `currentSrc` effect; guarded the dispatch in 3.2 with a check against this ref.
- [x] 3.5 RED (same file): assert no corrective behavior — after a mismatch report fires, `isPlaying`/`buffering`/`currentTime`/`currentSrc` are unchanged from their pre-report values. Also triangulated with a within-tolerance case asserting zero reports.
- [x] 3.6 Verify: `npx vitest run MusicPlayerProvider.media.test.tsx` green (14/14), including the security assertion from 3.1.

## Phase 4: `'full'` ThumbButtons Variant + Buffering UI (Integration)

Requirement: `music-track-feedback` (Full Variant Support, Mobile Full Player Rendering).

- [x] 4.1 RED: in `ThumbButtons.test.tsx`, assert `variant="full"` renders both thumb-up and thumb-down controls, and that the wrapper carries a `pf-thumbs--full` class distinct from `menu`/`bar`. RED signal was a `tsc` type error (`"full"` not assignable to `"menu" | "bar"`), not a runtime failure — noted in Deviations.
- [x] 4.2 GREEN: widened `ThumbButtonsProps.variant` to `'menu' | 'bar' | 'full'` in `src/features/music/ThumbButtons.tsx` (no rendering-logic change needed — labels already gate on `variant === 'menu'`, so `full` is icon-only for free).
- [x] 4.3 GREEN: added `.pf-thumbs--full` rules in `src/features/music/thumbs.css` — 44x44px targets, circular, `:active` (not `:hover`) state.
- [x] 4.4 RED: in `NowPlayingBar.test.tsx` with `setCompactViewport(true)`, assert `ThumbButtons variant="full"` renders as the leading item of `.pf-fullplayer__bottom` when `current.videoId` is defined, and does NOT render when `videoId` is undefined (mirrors the desktop `{current.videoId && (...)}` guard). Asserts a rating click reaches the same `useRatings().rate` store as the bar/menu variants.
- [x] 4.5 GREEN: in `NowPlayingBar.tsx`, inside `.pf-fullplayer__bottom` (leading item, before `.pf-fullplayer__volume`), added `{current.videoId && (<ThumbButtons videoId={current.videoId} title={current.title} variant="full" />)}`.
- [x] 4.6 RED: assert `ToggleButton` accepts an optional `buffering` prop and, when true, renders `aria-busy="true"` plus the `pf-nowplaying__toggle--buffering` class. Written against the desktop bar's toggle (visible surface for the test); the underlying prop/CSS is shared by all three call sites.
- [x] 4.7 GREEN: added optional `buffering?: boolean` prop to the `ToggleButton` component, threading it from context at ALL THREE call sites (desktop bar, compact bar, full player) rather than only the two named in the task — buffering is otherwise invisible on whichever surface is currently mounted, so all three were wired for consistency (see Deviations). Added the `pf-nowplaying__toggle--buffering` pulse rule (with a `prefers-reduced-motion` guard) to `NowPlayingBar.css`.
- [x] 4.8 Verify: `npx vitest run ThumbButtons.test.tsx NowPlayingBar.test.tsx` green (7 + 14). Manual (jsdom cannot verify): 44x44 tap target fit on a real small-phone viewport was NOT performed in this session — CSS layout fit is explicitly not vitest-assertable and no physical/emulated device was available.

## Phase 5: Worker Stream URL TTL (Independent Slice)

Requirement: `music-stream-resolution` (Extended Stream URL Cache Lifetime, Scope Boundary Is Explicit). No automated coverage exists for this file — do not claim vitest coverage.

- [x] 5.1 GREEN: changed `STREAM_URL_TTL = 300.0` to `STREAM_URL_TTL = 3600.0` at `infra/music-worker/server.py:75`. Updated the adjacent comment to state this is an S1 slow-start-latency fix only, explicitly NOT a fix for the 2x-duration defect (refuted by controlled experiment).
- [x] 5.2 Manual verify (no automated harness — jsdom/vitest cannot exercise Python or Docker): ran `docker compose up -d --build music-worker` from `infra/`; container rebuilt and started (`poisonflix-music-worker`, `Up`). Confirmed inside the running container via `python3 -c "import server; print(server.STREAM_URL_TTL)"` → `3600.0`, and confirmed `JELLYFIN_API_KEY` is present in the container's environment (proves `docker-compose.override.yml` applied — running from `infra/` was necessary). Startup log shows no errors. The live "two timed `/stream` requests >300s apart" behavioral check was NOT performed in this session — it requires a real YouTube-resolved track and a >5 minute wait, both outside this apply session's scope; documented as not verified rather than claimed.
- [x] 5.3 Manual verify: NOT independently exercised in this session (same reason as 5.2 — requires a live 403/410 upstream failure to observe). Code path is unchanged by this diff (only the `STREAM_URL_TTL` constant and its comment were touched; `_resolve_stream_url`'s `force=True` retry logic was not modified), so it is unaffected by inspection, but that claim was not exercised end-to-end here.

## Phase 6: Full-Suite Gate (Cleanup / Verification)

- [x] 6.1 Ran `npx vitest run` — full suite: 74 files, 560 tests, all green (up from the 72-file/525-test baseline; +2 files, +35 tests).
- [x] 6.2 Ran `npx tsc -b` — exit 0.
- [x] 6.3 Ran `npx oxlint` — exit 0.
- [x] 6.4 Confirmed the diagnostic payload assertion (3.1, `SECURITY: never includes the api_key or the raw stream src in a reported detail`) is intact, unweakened, and still passing in the final suite run — it is the last test added and was not touched after its GREEN implementation.
