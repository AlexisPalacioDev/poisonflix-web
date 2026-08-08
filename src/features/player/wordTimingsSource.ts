import { z } from 'zod';
import { splitIntoWords, type SubtitleCue, type WordTiming } from './subtitleCues';

// Real forced-alignment word timings - the seam `subtitleCues.ts`'s header
// promised for `estimateWordTimings` (median error ~310ms vs. the ~100ms a
// real forced-alignment model achieves, per two independently-run models
// agreeing on the live comparison). An OFFLINE generator (not this codebase)
// produces one JSON file per item, served statically at
// `/updates/wordtimings/{itemId}.json` (same Caddy mount as the APK
// self-update channel - `infra/Caddyfile`, intentionally public, no auth
// needed). THIS file is only the CLIENT side: fetch + cache + match against
// the already-parsed VTT cues. It does not generate anything.
//
// Contract (fixed by the generator side, not owned here):
//   { v: 1, item: "<itemId>", track: <subtitleStreamIndex>,
//     cues: [ { t: <cueStartSeconds>, w: [[startMs, endMs], ...] } ] }
// - `t` is the cue's own VTT `startSeconds` - the join key against
//   `SubtitleCue.startSeconds` (`subtitleCues.ts`).
// - `w` has one `[startMs, endMs]` pair per word, in order, MILLISECONDS
//   RELATIVE TO THE CUE'S OWN START (not absolute, not relative to a running
//   clock) - converted to absolute seconds in `resolveWordTimingsForCue`
//   below, matching `WordTiming`'s existing shape exactly.
// - A cue whose alignment wasn't confident enough is simply ABSENT from
//   `cues` - there is no flag/score to interpret, "not found" IS the
//   fallback signal.
//
// Fallback policy (owner instruction, verbatim): a 404 is the NORMAL case
// (most titles have no generated data yet), not an error - never logged,
// never surfaced. The same silent-fallback treatment applies to a slow/failed
// fetch, a non-2xx status, or a JSON body that fails validation: all of them
// just leave `estimateWordTimings` (`subtitleCues.ts`) as the active source,
// exactly like "no data" does. Nothing here ever blocks or delays playback -
// every caller gets a `Promise` that resolves, never rejects.

const WordTimingsCueSchema = z.object({
  t: z.number(),
  // Each pair is `[startMs, endMs]`, both relative to the cue's own start.
  w: z.array(z.tuple([z.number(), z.number()])),
});

const WordTimingsFileSchema = z.object({
  // Pinned to the one contract version this client understands - NOT just
  // "some number". If the generator ever ships `v: 2` with different offset
  // semantics (e.g. absolute instead of cue-relative), this must reject it
  // outright rather than silently apply the wrong interpretation - the
  // "corrupt/unexpected shape -> null" path (below) is exactly where a
  // version bump should land until this client is updated to match.
  v: z.literal(1),
  item: z.string(),
  track: z.number(),
  cues: z.array(WordTimingsCueSchema),
});

export type WordTimingsFile = z.infer<typeof WordTimingsFileSchema>;

/** A word's start/end in the generator's own JSON is close to, but not
 * guaranteed to be bit-identical to, the VTT cue's `startSeconds` it was
 * derived from - both round independently. This is generous enough to
 * absorb millisecond rounding while still being far narrower than the
 * typical gap between two consecutive cues (seconds, not milliseconds), so
 * it cannot accidentally match the WRONG cue. */
const CUE_MATCH_TOLERANCE_SECONDS = 0.05;

/** Per-item cache of the in-flight/settled fetch, so switching subtitle
 * TRACKS (which re-renders `WordHighlightedLine` repeatedly, potentially
 * with a different `trackIndex`) never re-requests the same item's file -
 * the whole file (covering every track the generator processed) is fetched
 * once and reused; per-track applicability is decided later, per cue, by
 * `resolveWordTimingsForCue`'s own `file.track !== trackIndex` check.
 *
 * A settled SUCCESS stays cached for the rest of the session - the file is
 * static (produced offline), so there is never a reason to re-fetch it. A
 * settled `null` (no data / fetch failed / corrupt) is deliberately NOT kept
 * - see the eviction below `fetchWordTimingsData`'s own `.then()`. Caching a
 * failure forever would mean a transient network blip while the player
 * happens to open permanently loses real alignment for that item for the
 * rest of the session, with no way to recover short of a full page reload -
 * worse than the plain "this title has no data" case it was meant to cover,
 * and NOT required by "cache per item, don't refetch per track" (this
 * module's fetch already only runs once per MOUNT, not per track switch,
 * regardless of whether a failure is remembered). */
const cache = new Map<string, Promise<WordTimingsFile | null>>();

/**
 * Fetches and validates the word-timings file for `itemId`, memoized per
 * item. Resolves `null` - never rejects - for every "no usable data" case:
 * HTTP non-2xx (404 is the expected common case, not an error), a network
 * failure, a response body that isn't valid JSON, or JSON that doesn't match
 * `WordTimingsFileSchema` (a corrupt/unexpected shape). Callers should treat
 * `null` exactly like "never checked" - fall back to `estimateWordTimings`.
 */
export function fetchWordTimingsData(itemId: string): Promise<WordTimingsFile | null> {
  const cached = cache.get(itemId);
  if (cached) return cached;

  const promise = fetch(`/updates/wordtimings/${encodeURIComponent(itemId)}.json`)
    .then((response) => {
      if (!response.ok) return null; // includes the normal 404 "no data yet" case
      return response.json();
    })
    .then((data) => {
      const parsed = WordTimingsFileSchema.safeParse(data);
      if (!parsed.success) return null; // corrupt/unexpected JSON shape
      // Belt-and-suspenders: the file MUST describe the item it was fetched
      // for. A mismatch here would mean a wrong/stale file got served at
      // this path - ignore the whole file rather than risk applying another
      // title's timings.
      if (parsed.data.item !== itemId) return null;
      return parsed.data;
    })
    .catch(() => null); // network error, non-JSON body, etc.

  cache.set(itemId, promise);
  // Evict on failure only (see the cache's own doc comment above) - a later,
  // independent call for the same item gets a fresh attempt instead of being
  // stuck with whatever went wrong the first time. The identity check guards
  // against deleting a NEWER cache entry in the (currently unreachable, but
  // cheap to guard) case that something else already replaced this exact
  // promise for `itemId` by the time this settles.
  promise.then((result) => {
    if (result === null && cache.get(itemId) === promise) cache.delete(itemId);
  });
  return promise;
}

/** Slack (in ms) allowed on top of `CUE_MATCH_TOLERANCE_SECONDS` when sanity
 * checking a matched cue's own offsets in `offsetsAreSane` - the same
 * rounding leeway the cue-matching tolerance already grants, expressed in
 * milliseconds since `w` is milliseconds. */
const OFFSET_SANITY_SLACK_MS = CUE_MATCH_TOLERANCE_SECONDS * 1000;

/**
 * Defends against a matched cue's `w` entries that are the right LENGTH
 * (already checked by the caller) but not otherwise trustworthy - e.g. a
 * generator bug that emitted absolute timestamps instead of cue-relative
 * ones, or `endMs` before `startMs`. The contract (this file's header)
 * guarantees offsets are non-negative, ordered, and bounded by the cue's own
 * duration; this checks the guarantee actually holds instead of trusting it
 * blindly. Schema validation (`WordTimingsCueSchema`) cannot catch this on
 * its own - it validates SHAPE (two numbers), not whether those numbers are
 * physically sane RELATIVE TO the cue they claim to describe.
 */
function offsetsAreSane(w: z.infer<typeof WordTimingsCueSchema>['w'], cueDurationMs: number): boolean {
  let previousEndMs = -OFFSET_SANITY_SLACK_MS;
  for (const [startMs, endMs] of w) {
    if (startMs < -OFFSET_SANITY_SLACK_MS) return false; // meaningfully negative - not "relative to this cue"
    if (endMs < startMs) return false; // a word can't end before it starts
    if (startMs < previousEndMs - OFFSET_SANITY_SLACK_MS) return false; // words must stay in order
    if (endMs > cueDurationMs + OFFSET_SANITY_SLACK_MS) return false; // can't run past the cue itself
    previousEndMs = endMs;
  }
  return true;
}

/**
 * Real per-word timings for `cue`, drawn from `file`, if and only if:
 *  - `file` exists and its `track` matches the subtitle stream `cue` came
 *    from (`trackIndex`) - the user may be watching a DIFFERENT subtitle
 *    track than the one the file was generated for, in which case this
 *    file's timings simply don't apply to what's on screen right now;
 *  - a cue in `file.cues` matches `cue.startSeconds` within
 *    `CUE_MATCH_TOLERANCE_SECONDS`;
 *  - that matched cue's word count equals `cue`'s own word count - a
 *    mismatch means the subtitle text changed since the data was generated,
 *    so the offsets no longer line up with today's words and must be
 *    discarded rather than misapplied to the wrong tokens;
 *  - those offsets pass `offsetsAreSane` - non-negative, ordered, and within
 *    the cue's own duration (see that function's doc comment).
 * Returns `null` in every other case, signaling "fall back to
 * `estimateWordTimings`" to the caller - this function never estimates
 * itself, it only looks up real data or declines.
 */
export function resolveWordTimingsForCue(
  file: WordTimingsFile | null,
  cue: SubtitleCue,
  trackIndex: number,
): WordTiming[] | null {
  if (!file || file.track !== trackIndex) return null;

  const words = splitIntoWords(cue.text);
  if (words.length === 0) return null;

  let best: z.infer<typeof WordTimingsCueSchema> | null = null;
  let bestDiff = Infinity;
  for (const candidate of file.cues) {
    const diff = Math.abs(candidate.t - cue.startSeconds);
    if (diff <= CUE_MATCH_TOLERANCE_SECONDS && diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  if (!best || best.w.length !== words.length) return null;

  const cueDurationMs = (cue.endSeconds - cue.startSeconds) * 1000;
  if (!offsetsAreSane(best.w, cueDurationMs)) return null;

  return words.map((word, i) => {
    const [startMs, endMs] = best.w[i];
    return {
      word,
      startSeconds: cue.startSeconds + startMs / 1000,
      endSeconds: cue.startSeconds + endMs / 1000,
    };
  });
}

/** Test-only reset - the module-level cache would otherwise leak state
 * between test cases that fetch the same `itemId`. */
export function __resetWordTimingsCacheForTests(): void {
  cache.clear();
}
