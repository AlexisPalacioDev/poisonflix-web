# Proposal: Music Player Reliability

## Intent

The player lies about its own state. `state.isPlaying` is optimistic and never reconciled
with the `<audio>` element, so a stalled stream leaves the UI showing PAUSE while iOS
Control Center shows PLAY (screenshot evidence). Mobile users also cannot rate a track at
all. Separately, iOS reports 2x the real duration — the exploration blamed a
`STREAM_URL_TTL` re-resolve splice, but a controlled Chromium experiment (same bytes, with
and without Range serving) reported the correct 193.18s both times, and a 407.9s linear
read across the TTL boundary returned exact bytes. That cause is **refuted**; the mechanism
is unidentified and iOS-WebKit-specific. We ship the confirmed fixes and instrument the
unknown instead of guessing.

## Scope

### In Scope

- **S4 — reconcile playback state.** Wire `onPlay`/`onPlaying`/`onPause`/`onWaiting`/`onStalled` in `MusicPlayerProvider.tsx`, guarded so the iOS unlock probe (`:203-223`, deliberate `play()->pause()`) cannot flip state.
- **S2 — instrumentation only.** On `durationchange` and `ended`, when element `duration` disagrees with `track.durationSeconds` beyond a tolerance, emit `duration`, `seekable.end`, `buffered.end`, `currentTime`, `readyState` via `reportFailure` (`src/lib/obs/report.ts` → console + `window.__pfErrors`).
- **S3 — mobile rating.** New `'full'` variant on `ThumbButtons` (today only `'menu' | 'bar'`) plus CSS, rendered in `FullPlayer` (`NowPlayingBar.tsx:374-537`).
- **S1 — cheap half.** Raise `STREAM_URL_TTL` (`server.py:75`) past real googlevideo URL lifetime; the constant's own comment says hours.

### Out of Scope (non-goals)

- Any behavioural fix for the 2x duration until instrumentation identifies the mechanism.
- Stream throughput (~32 KB/s measured) — likely driver of the underruns behind S4's stalls. Follow-up.
- Predictive pre-warm of the next queued track.
- Two documented-but-unverified bugs: the `currentItemId`-vs-`currentSrc` effect key, and missing `ENQUEUE` dedupe causing duplicate radio requests. Verify-then-fix as follow-up.

## Capabilities

### New Capabilities

- `music-playback-state`: element-truth reconciliation of playing/paused/buffering.
- `music-playback-diagnostics`: duration-mismatch telemetry through the failure channel.
- `music-track-feedback`: like/dislike parity across desktop bar and mobile full player.
- `music-stream-resolution`: worker stream-URL cache lifetime.

### Modified Capabilities

- None (`openspec/specs/` does not yet exist).

## Approach

Four independent slices, no shared abstraction. Media events become the single source of
truth for `isPlaying`, with a `buffering` flag distinct from paused so a stall is visible
rather than silent. Diagnostics reuse the existing `reportFailure` channel — no new
transport. Strict TDD via `npx vitest run`; the worker constant is verified by inspection.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/features/music/MusicPlayerProvider.tsx` | Modified | Media event handlers, unlock-probe guard, duration diagnostics |
| `src/features/music/musicPlayerCore.ts` | Modified | Buffering state / reconcile actions |
| `src/features/music/ThumbButtons.tsx` | Modified | `'full'` variant |
| `src/features/music/NowPlayingBar.tsx` | Modified | `ThumbButtons` in `FullPlayer` |
| Music CSS | Modified | `'full'` variant styles |
| `infra/music-worker/server.py` | Modified | `STREAM_URL_TTL` |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| New handlers fight the iOS unlock probe, creating a fresh desync | Med | Suppress reconciliation while the probe runs; cover with tests |
| `onWaiting` on a slow stream flaps the UI | Med | Separate `buffering` flag; do not clear `isPlaying` |
| Longer TTL serves a genuinely expired googlevideo URL | Low | Existing `force=True` re-resolve path on upstream failure |
| Instrumentation never fires because the bug is iOS-only | Med | Accepted — it lands in `window.__pfErrors` on the next real repro |

## Rollback Plan

Per-slice revert; none depend on each other. Worker: restore `STREAM_URL_TTL = 300.0` and
restart. SPA: revert the commit — handlers, `'full'` variant, and diagnostics are additive.

## Dependencies

None. No new packages, no API or schema changes.

## Success Criteria

- [ ] `isPlaying` matches element state after stall, external pause, and lock-screen control.
- [ ] A stalled stream shows buffering, never a paused-looking PLAY button that is actually playing.
- [ ] Like/dislike reachable from the mobile full player.
- [ ] A duration mismatch emits a full media-state record to `window.__pfErrors`.
- [ ] `npx vitest run` green; change stays under the 800-line review budget.
