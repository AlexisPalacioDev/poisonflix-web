# Design: Music Player Reliability

## Technical Approach

Media events become the truth for `isPlaying`. Every non-trivial rule is factored into a **pure
reducer action** or a **pure exported function**, so the only untested surface is thin DOM→dispatch
wiring. Four independent slices, no shared abstraction.

## Architecture Decisions

### A. Event set and reconciliation

One new action `SYNC_MEDIA { playing?: boolean; buffering?: boolean }` (partial patch, returns
`state` identity when nothing changes — no render churn on the ~4-60/s event stream). Rejected: five
per-event actions (reducer bloat), reusing `SET_PLAYING` (it is *intent*; conflating it with
*observation* loses the identity-return and makes tests ambiguous).

| Element event | Dispatch | Note |
|---|---|---|
| `play` | `{ playing: true }` | swallowed while probe window open |
| `playing` | `{ playing: true, buffering: false }` | cancels pending settle timer |
| `pause` | `{ playing: false, buffering: false }` | swallowed if probe open **or** `el.ended` |
| `waiting` / `stalled` | arms settle timer (see B) | never touches `isPlaying` |
| `canplay` | `{ buffering: false }` | stuck-spinner insurance |

`el.ended` guard: Safari can fire `pause` *after* `ended`; without it, `pause` would cancel the
`NEXT` auto-advance. Testable via a defined `ended` property.

**`buffering` is reducer state, not a ref** — it must re-render the toggle; a ref cannot. Exposed as
`buffering: state.buffering && state.isPlaying` so a stuck flag can never outlive playback, which
removes the need to reset it in all 11 track-change reducer branches.

### A2. Probe suppression window (highest risk)

`probeRef` opens **synchronously before** the probe's `play()` and closes **from the `pause` handler
itself** — the promise `.finally()` is a microtask and lands before the `pause` event task, so it is
too early. `unlockedRef` cannot serve: it is already true elsewhere by then.

```ts
probeRef.current = true;                 // MusicPlayerProvider.tsx:210, before play()
p.then(() => {
  if (stateRef.current.isPlaying) { probeRef.current = false; return; } // user won the race
  audio.pause();                         // its `pause` event closes the window
}).catch(() => { probeRef.current = false; });
window.setTimeout(() => { probeRef.current = false; }, 3000); // belt: never dead-lock reconciliation
```

A leaked probe-`pause` after the timeout is harmless: the probe only runs when `!isPlaying`, so the
dispatch hits the identity-return path. The conditional `pause()` also closes a pre-existing race
where the probe stopped genuine gesture-started playback.

### B. Buffering hysteresis

**Assert after 600 ms, clear immediately.** Asymmetric: at ~32 KB/s sub-600 ms underruns are routine
and invisible to the ear; a spinner that appears at all then represents a real stall. Immediate clear
guarantees the indicator never outlives the stall — the exact failure class this change exists to
kill. Rejected: symmetric debounce and a minimum-show window (both reintroduce a lying UI).

Timer lives in a `bufferingTimerRef` in the provider (reducer stays pure), cleared on unmount.
`BUFFERING_SETTLE_MS = 600` exported from `musicPlayerCore.ts` for tests.

### C. Diagnostics

Scope `music.player.durationMismatch`. Predicate extracted pure and exported:
`durationMismatch(elementDuration, trackDuration): boolean` — true when both are finite and positive
and `|el - known| > max(2, known * 0.05)`. 5% tolerates remux drift; a 2x error is 100% off, so the
band cannot mask it. 2 s floor covers short tracks.

De-dupe: `durationReportedRef` holds the reported track key; reset to `null` in the existing
`currentSrc` effect. At most one report per track load — `durationchange` repeats on a growing
stream and the ring buffer is only 100 entries.

Payload: `elementDuration`, `trackDuration`, `currentTime`, `readyState`, `seekableEnd`,
`bufferedEnd`, `event`, `itemId`, `videoId`. **`src` is deliberately excluded** — it embeds the
Jellyfin `api_key`. `TimeRanges.end()` throws on an empty range, so both are read through a
`null`-returning guard (jsdom exercises exactly that path).

### D. `'full'` variant

Union becomes `'menu' | 'bar' | 'full'`; labels already gate on `variant === 'menu'`, so `full` is
icon-only for free. Placed as the **leading item of `.pf-fullplayer__bottom`** (→ thumbs · volume ·
queue), guarded by `current.videoId`. Not the transport row: it already packs 5 controls at 52px plus
a 68px toggle under `gap: clamp(0.5rem,4vw,1.25rem)` and the CSS comment at `NowPlayingBar.css:442`
says it must fit small phones. CSS lives in `thumbs.css` beside the other variants: 44×44px
(iOS minimum tap target), circular, `:active` not `:hover` (touch surface).

Rejected: reusing `variant="bar"` with a wrapper class in `NowPlayingBar.css` — cross-file
specificity dependency on `.pf-thumbs__btn` internals, and `bar`'s 0.35rem padding yields a ~32px
target. Rejected: a `className` prop — breaks the `pf-thumbs--{variant}` convention.

`ToggleButton` gains an optional `buffering` prop → `aria-busy="true"` +
`pf-nowplaying__toggle--buffering` pulse. Without it, `buffering` is state nobody can see.

### F. Worker TTL

`STREAM_URL_TTL = 3600.0`. googlevideo `expire` runs hours out (the constant's own comment agrees);
`yt-dlp -g` costs 2.1-2.3 s and at 300 s TTL the *second* play of any 3-4 min track misses. Not 6 h:
`_stream_cache` is an unbounded dict with no eviction, and a longer TTL widens the stale window.
Staleness is already absorbed by the `force=True` re-resolve on 403/410 (`server.py:1479-1487`),
costing one retry. **Explicitly an S1 latency fix, not an S2 fix** — the splice theory was refuted by
controlled experiment.

## Data Flow

    <audio> events ──→ handler (probe guard, settle timer) ──→ SYNC_MEDIA ──→ reducer
                  └──→ durationMismatch() ──→ reportFailure ──→ window.__pfErrors
    reducer state ──→ context { isPlaying, buffering } ──→ ToggleButton / FullPlayer

## File Changes

| File | Action | Description |
|---|---|---|
| `src/features/music/musicPlayerCore.ts` | Modify | `buffering` field, `SYNC_MEDIA`, `BUFFERING_SETTLE_MS`, `durationMismatch()`, context field |
| `src/features/music/MusicPlayerProvider.tsx` | Modify | 5 handlers, probe window, settle timer, duration diagnostics |
| `src/features/music/ThumbButtons.tsx` | Modify | `'full'` in the variant union |
| `src/features/music/thumbs.css` | Modify | `.pf-thumbs--full` rules |
| `src/features/music/NowPlayingBar.tsx` | Modify | `ThumbButtons variant="full"`, `ToggleButton buffering` |
| `src/features/music/NowPlayingBar.css` | Modify | buffering pulse |
| `infra/music-worker/server.py` | Modify | `STREAM_URL_TTL = 3600.0` |
| `src/features/music/MusicPlayerProvider.media.test.tsx` | Create | reconciliation + probe + buffering + diagnostics |
| `src/features/music/musicPlayerCore.media.test.ts` | Create | reducer + `durationMismatch` units |

## Interfaces / Contracts

```ts
| { type: 'SYNC_MEDIA'; playing?: boolean; buffering?: boolean }
export const BUFFERING_SETTLE_MS = 600;
export function durationMismatch(elementDuration: number, trackDuration?: number | null): boolean;
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (pure) | `SYNC_MEDIA` transitions, identity-return, `durationMismatch` boundaries | direct reducer/function calls, no React |
| Integration | `play`/`pause`/`waiting`/`playing`/`canplay` → state; `ended`-guarded pause; probe suppression | `fireEvent.*(audioEl())`, `Object.defineProperty` for `ended`/`duration` |
| Integration | 600 ms settle | `vi.useFakeTimers()`, advance 599 → false, 600 → true |
| Integration | one report per track | `clearRecordedFailures()` / `recordedFailures()`, fire `durationchange` twice → 1 |
| Component | `'full'` variant renders and rates; buffering `aria-busy` | existing `ThumbButtons.test.tsx` + `setCompactViewport(true)` in `NowPlayingBar.test.tsx` |

**Honestly NOT assertable under jsdom** (stated plainly, per the `useMusicScrobble` precedent where a
comment like this hid a real bug):

1. That iOS actually emits `waiting`/`stalled` on a real underrun, and with what timing. We prove
   only our handling of synthetic events.
2. Real iOS promise-resolution ordering of the unlock probe versus its `pause` event.
3. Whether the duration diagnostic ever fires on a real device — it instruments an unreproduced bug.
4. CSS fit of `'full'` on a real phone.
5. `STREAM_URL_TTL` — no Python suite exists; inspection plus `cd infra && docker compose up -d
   --build music-worker`, then a repeat play >5 min later with no `yt-dlp` resolve in the log.

Mitigation for (1)-(4): every decision lives in a pure function or reducer action that *is* asserted.

## Threat Matrix

| Boundary | Applicable | Behaviour / RED test |
|---|---|---|
| Data exposure in logs | **Yes** | Diagnostic payload must never contain `src` (carries the Jellyfin `api_key`). RED test asserts no recorded failure detail contains `api_key`. |
| Routing / shell / subprocess | N/A | The worker change is a numeric constant; `yt-dlp` invocation and argument construction are untouched. |
| VCS/PR automation, executable-file classification | N/A | Not touched. |

## Migration / Rollout

No migration. SPA changes are additive and revert with the commit. Worker: restore `300.0` and
`docker compose up -d --build music-worker`.

Forecast: ~160 source lines + ~400 test lines ≈ 560 changed. Single PR, under the 800-line budget.

## Open Questions

- [ ] None blocking. Residual: if the probe's `play()` neither resolves nor rejects, the 3 s timer is
      the only thing restoring reconciliation — accepted, since a leaked probe-`pause` is a no-op.
