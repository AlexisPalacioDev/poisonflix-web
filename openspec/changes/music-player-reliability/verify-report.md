```yaml
schema: gentle-ai.verify-result/v1
verdict: pass_with_warnings
blockers: 1
critical_findings: 2
requirements: 8/9
scenarios: 13/16
test_command: npx vitest run
test_exit_code: 0
test_output_hash: sha256:d7a0016fa70e34ee2849ae4bc13b21e3f5d9567f2b21523415701f4dfd938508
build_command: npx tsc -b
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
lint_command: npx oxlint
lint_exit_code: 0
```

# Verification Report — music-player-reliability

**Commit**: 3ee42c8 on feat/projector-web-integration. Working tree clean, matches commit exactly.
**Mode**: Strict TDD.

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 38 |
| Tasks complete | 38 |

## Build & Tests

- `npx vitest run` -> 74 files / 560 tests, all green (baseline 72/525 confirmed via apply-progress delta; current run matches the +2 files/+35 tests claim exactly).
- `npx tsc -b` -> exit 0, zero errors.
- `npx oxlint` -> exit 0, zero errors/warnings.
- `docker exec poisonflix-music-worker python3 -c "import server; print(server.STREAM_URL_TTL)"` -> `3600.0`, confirmed on the already-running container (no rebuild performed, per instruction).

## Spec Compliance Matrix (source-inspected + test-verified)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Playing State Reconciliation | external pause reconciles | `MusicPlayerProvider.media.test.tsx > an external pause event reconciles isPlaying to false` | COMPLIANT |
| Playing State Reconciliation | playing/play event confirms play | same file, 2 tests | COMPLIANT |
| Unlock Probe Suppression | probe does not flip real state | `the probe play()->pause() sequence does not flip isPlaying as a direct result` | COMPLIANT (see WARNING below — does not discriminate `probeRef` from `unlockedRef` as guard) |
| Unlock Probe Suppression | probe still marks unlocked (`unlockedRef.current` true) | none — explicitly documented in the test file as not observable from any test surface | CRITICAL — UNTESTED |
| Buffering Distinct From Paused | stall does not report as paused | `a stall (waiting) does not report as paused...` | COMPLIANT |
| Buffering Distinct From Paused | resume clears buffering | `playing clears buffering immediately...` | COMPLIANT |
| Buffering Settle Window | short blip does not surface | same test, 599ms->600ms boundary | COMPLIANT (value is 600ms, not spec's provisional 250ms — documented, justified deviation) |
| Buffering Settle Window | sustained stall surfaces | same test | COMPLIANT |
| Duration Mismatch Reporting | reported on `durationchange`, fields present | `SECURITY:...` + `reads seekable/buffered end...` | PARTIAL — only 2 of 7 declared fields get an explicit per-field assertion |
| Duration Mismatch Reporting | reported on `ended`, same fields | none | CRITICAL — UNTESTED |
| Duration Mismatch Reporting | within tolerance does not report | `does not report when the duration is within tolerance` | COMPLIANT |
| No Corrective Behavior | diagnostic firing does not change playback | `does NOT alter playback state as a side effect of reporting` | COMPLIANT |
| No Corrective Behavior | reporting never throws | `reads seekable/buffered end through a null-returning guard instead of throwing` | COMPLIANT |
| Full Variant Support | renders both controls | `ThumbButtons.test.tsx > renders both thumb-up and thumb-down controls` | COMPLIANT |
| Full Variant Support | full-scoped class | `carries a pf-thumbs--full wrapper class distinct from menu/bar` | COMPLIANT |
| Mobile Full Player Rendering | renders when videoId defined / guard / rating reaches store | `NowPlayingBar.test.tsx` — 3 tests | COMPLIANT |
| Extended Stream URL Cache Lifetime | manual repeat-play check | not executed (documented as unverified, not claimed) | NOT VERIFIABLE in this environment |
| Scope Boundary Is Explicit | TTL comment scopes to S1 only | source inspection: `server.py:75-86` | COMPLIANT |

**Compliance summary**: 13/16 scenarios independently test-verified compliant, 1/16 partial, 2/16 untested (both honestly disclosed, not claimed as tested by apply-progress).

## Security Requirement (deep check)

`MusicPlayerProvider.media.test.tsx > SECURITY: never includes the api_key or the raw stream src in a reported detail` is non-vacuous: it first asserts `srcBefore` (the real `audio` element's `src` attribute) contains `api_key=tok` — proving the src genuinely carries the secret — before asserting no recorded failure's serialized detail contains `api_key`, the full `srcBefore` string, or `stream.m4a`. Reverting the `src`-omission in `MusicPlayerProvider.tsx`'s `reportDurationMismatch` payload would fail this test. Source inspection of the payload object literal (`MusicPlayerProvider.tsx:322-332`) confirms `src` is genuinely absent from the 9 keys sent to `reportFailure`. CONFIRMED non-vacuous and correct.

## Probe Suppression (deep check)

Source-confirmed exact match to design: `probeRef.current = true` set synchronously on line 243, immediately before `audio.play()` on line 244 (both inside the same synchronous `unlock()` handler). The suppression window is closed from the `onPause` handler itself (line 575-580), never in a `.then()`/`.catch()` microtask. `unlockedRef` is a separate ref used only to decide whether a rejected declarative `play()` should flip `isPlaying` back — it is never read by `onPlay`/`onPause`. Confirmed correct by source inspection.

Adversarial spot-check of the covering test found a real assertion-quality gap: by the time the probe-suppression test fires the probe, `unlockedRef.current` is already `true` (set by the earlier `playNow` call's resolved `play()` promise, which never resets). If the implementation were mentally reverted to check `unlockedRef.current` instead of `probeRef.current`, this specific test would still pass. The test proves suppression happens, but does not by itself prove which ref gates it. WARNING, not CRITICAL — the source is correct; the test's triangulation for this one specific claim is weak.

## Buffering (deep check)

`visibleBuffering(state) = state.buffering && state.isPlaying`, unit-tested directly (3 non-vacuous cases). 600ms to assert / immediate to clear, confirmed by the 599ms->600ms boundary test and zero-timer-advance clear tests. A stall never flips `isPlaying` false: confirmed by direct assertion and by the reducer's `SYNC_MEDIA` case only patching fields explicitly present in the action. Confirmed correct.

## Non-Goals (deep check)

Full diff review confirms: no other reducer branch was touched — `ENQUEUE`'s dedupe behavior is byte-for-byte unchanged. The `currentSrc` (not `currentItemId`) effect key is unchanged except for two added `durationReportedRef.current = null` reset lines inside existing branches. No throughput/pre-warm code anywhere in the diff. Confirmed: nothing snuck in.

## Deviations from spec (documented, not hidden)

- `BUFFERING_SETTLE_MS = 600`, not the spec's flagged assumption of 250ms — spec artifact itself labeled 250ms an assumption; design explicitly overrode it with a throughput-based rationale. WARNING, not CRITICAL.
- `ToggleButton buffering` wired to all 3 call sites; design/tasks named only 2. Documented deviation, sound rationale, no spec conflict. SUGGESTION.

## Issues Found

**CRITICAL**:
1. Spec scenario "probe still marks unlocked" has zero covering test — only source-inspected. Honestly disclosed by apply-progress.
2. Spec scenario "reported on ended — same fields" has zero covering test — no test fires `ended` on a duration-mismatched track. Source wiring is a single line reusing an already-unit-tested function (low residual risk), but formally untested.

**WARNING**:
1. Duration-mismatch payload field completeness asserted for only 2/7 fields directly; rest confirmed only by source inspection.
2. Probe-suppression test cannot discriminate `probeRef`-based suppression from a design-forbidden `unlockedRef`-based suppression in its own setup sequence.
3. `BUFFERING_SETTLE_MS=600` deviates from spec's flagged 250ms assumption — justified, documented, but user-visible latency change worth flagging.

**SUGGESTION**:
1. `buffering` wired to a 3rd `ToggleButton` call site beyond what tasks named — reasonable generalization, documented, zero spec conflict.

## Not Verifiable In This Environment

1. Real iOS promise-resolution ordering of the unlock probe vs. its `pause` event.
2. Real device stall (`waiting`/`stalled`) timing and whether iOS actually emits these events on a genuine underrun.
3. Whether the duration-mismatch diagnostic ever fires on a real device.
4. CSS fit of the `'full'` ThumbButtons variant on a real phone (jsdom has no layout engine).
5. `STREAM_URL_TTL`'s actual multi-minute cache-hit behavior — only the static in-container constant value was checked; the >300s two-request timing check and the `force=True`-on-403/410 live path were not executed.

## Verdict

**PASS WITH WARNINGS.** All 38 tasks complete, all gates (vitest/tsc/oxlint) green with matching evidence, worker TTL confirmed live in the running container, security requirement genuinely non-vacuous, probe-suppression and buffering logic correctly implemented per design (confirmed via source). Two spec scenarios are formally untested (both edge-case completeness items around the diagnostics feature, both honestly disclosed by apply-progress rather than falsely claimed) — not release-blocking for a diagnostic-only, non-corrective feature, but should not be silently archived as "spec fully proven by test" without acknowledging these two gaps.
