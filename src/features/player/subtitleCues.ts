// WebVTT subtitle cue parsing for the dual-subtitle overlay (owner request:
// "me gustaría poder leer también los sub en inglés y en español" -
// this is a LANGUAGE-LEARNING feature, not accessibility: read English while
// listening, Spanish alongside for meaning. `VideoSurface.tsx`'s existing
// single-subtitle path keeps using the browser's native `<track>` element
// unchanged (a browser already paints ONE subtitle track well); this parser
// exists ONLY for the second, SIMULTANEOUS subtitle case, where a browser
// cannot be trusted to stack two `<track>` cues in two predictable rows (see
// VideoSurface.tsx's header for the full design rationale). A minimal,
// dependency-free WebVTT reader - this codebase has no subtitle-parsing
// library, and the feature needed here (timed plain-text cues) is small
// enough not to justify pulling one in.
//
// ## Word-level highlight timing (owner request: "resaltar la palabra que se
// está pronunciando" - follow the English audio with your eyes while it
// plays). ENGLISH ONLY, by owner instruction verbatim: Spanish is a
// TRANSLATION, not a transcription - nobody actually speaks those words and
// their order doesn't correspond to the English audio, so a word-by-word
// karaoke effect on the Spanish row would invent a correspondence that does
// not exist. `VideoSurface.tsx` decides WHICH row (primary/second) is
// English via `languageFamily(track.language) === 'en'` and only calls
// `estimateWordTimings` for that row; the other row keeps rendering as plain
// text (line-level, unchanged from before this feature).
//
// This first version does NOT process audio. It estimates each word's timing
// by splitting the CUE's own [startSeconds, endSeconds) window proportionally
// to word length (a longer word roughly takes longer to say) - see
// `estimateWordTimings` below for the exact weighting. This is a deliberate
// placeholder for real forced alignment, not a permanent design: the seam
// that makes swapping it out later cheap is `WordTiming[]`'s SHAPE, not this
// algorithm. A future version could replace `estimateWordTimings`'s body with
// real per-word timestamps (e.g. from an alignment service) and nothing
// downstream - `activeWordIndex`, `tokenizeCueText`, or any of
// `VideoSurface.tsx`'s render code - would need to change, as long as it
// keeps producing an array of `{ word, startSeconds, endSeconds }` covering
// the same cue window. Error does not accumulate ACROSS cues: every cue
// re-anchors its own words to ITS OWN `startSeconds`/`endSeconds` (never to a
// running clock), so a bad estimate is contained within one 2-6s line
// instead of drifting further out of sync the longer the movie plays.
//
// KNOWN, ACCEPTED LIMITATION: `VideoSurface.tsx` only re-evaluates which word
// is active on the `<video>`'s own `timeupdate` event, which browsers fire at
// roughly 4Hz (~every 250ms), not on every animation frame. On a short, fast
// line of dialogue this can skip highlighting a brief word entirely (its
// whole estimated window falls between two `timeupdate` ticks) rather than
// ever landing exactly on it. This does NOT break monotonicity or the
// "never overrun the cue" guarantee above - the highlight still only ever
// moves forward and never exceeds the cue - it just means a viewer may see
// the highlight jump over one short word on rapid dialogue instead of
// visiting every single one. Not fixed here: a `requestAnimationFrame` loop
// would raise the sampling rate, at the cost of a render-loop this feature's
// "estimate, don't measure" scope doesn't currently justify.

export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  /** Cue text with VTT markup tags stripped (`<b>`, `<i>`, inline
   *  `<00:00:01.000>` karaoke timestamps, `<c.classname>`, etc.) - kept as
   *  plain text. Word-level highlighting (this file's header) does NOT use
   *  any inline karaoke timestamps a VTT might carry even when present -
   *  `estimateWordTimings` always re-derives its own per-word estimate from
   *  this plain text plus the cue's own `startSeconds`/`endSeconds`, the
   *  same way for every subtitle file regardless of what markup the source
   *  VTT happened to include. That keeps ONE estimation path instead of a
   *  "use real timestamps when they exist, else estimate" branch - a
   *  deliberate simplicity tradeoff for this first version, not an
   *  oversight; revisit if a real alignment source is ever wired in (see
   *  this file's header on `WordTiming[]`'s shape being the intended seam). */
  text: string;
}

// `HH:MM:SS.mmm` or `MM:SS.mmm` - WebVTT allows both; the hours group is
// optional per the spec.
const TIMESTAMP_RE = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;

function parseTimestamp(raw: string): number | null {
  const match = TIMESTAMP_RE.exec(raw);
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
}

/** Strips VTT markup tags (`<b>text</b>`, `<00:00:01.000>`, `<c.yellow>`...)
 * down to plain text - including any inline `<00:00:01.500>` karaoke
 * timestamps a source VTT might carry. Word-level highlighting (this file's
 * header) does not read those even when present; it re-estimates every
 * word's timing from the cue's own start/end instead (one estimation path
 * for every file, not "real timestamps when available, else estimate"). */
function stripMarkup(line: string): string {
  return line.replace(/<[^>]*>/g, '');
}

/**
 * Parses a WebVTT file's cue list. Deliberately permissive: unknown blocks
 * (the `WEBVTT` header itself, `STYLE`, `REGION`, `NOTE`) are skipped rather
 * than rejected - a subtitle file with one feature this parser doesn't
 * understand should still show its TEXT, not disappear entirely from the
 * dual overlay.
 */
export function parseVttCues(vttText: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // WebVTT blocks are separated by one or more blank lines; normalize
  // Windows line endings first - Jellyfin's `Stream.vtt` has been observed
  // to send `\r\n`.
  const blocks = vttText.replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    // The timing line is either the first line (no cue identifier) or the
    // second (an identifier sits on its own line first) - find whichever
    // line actually contains the `-->` separator instead of assuming a fixed
    // position, so both shapes parse the same way.
    const timingLineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingLineIndex === -1) continue; // WEBVTT header, STYLE/REGION/NOTE block, etc.

    const [startRaw, endRaw] = lines[timingLineIndex].split('-->').map((s) => s.trim());
    const start = parseTimestamp(startRaw);
    const end = endRaw ? parseTimestamp(endRaw.split(/\s+/)[0]) : null;
    if (start == null || end == null) continue;

    const text = lines
      .slice(timingLineIndex + 1)
      .map(stripMarkup)
      .join('\n')
      .trim();
    if (!text) continue;

    cues.push({ startSeconds: start, endSeconds: end, text });
  }

  return cues;
}

/**
 * All cue text active at `currentTimeSeconds`, joined by newline - a VTT can
 * legitimately carry overlapping cues (rare, but valid). Returns `null` when
 * nothing is active, so callers can tell "no subtitle right now" apart from
 * an active-but-empty cue.
 */
export function activeCueText(cues: SubtitleCue[], currentTimeSeconds: number): string | null {
  const active = activeCues(cues, currentTimeSeconds);
  if (active.length === 0) return null;
  return active.map((cue) => cue.text).join('\n');
}

/**
 * All cues active at `currentTimeSeconds` - the same filter `activeCueText`
 * joins into a display string, exposed separately for callers that need the
 * CUE OBJECTS (start/end, for word-highlight timing) rather than just text.
 * `VideoSurface.tsx` uses this to find the single cue currently driving the
 * word-highlight overlay; when more than one cue legitimately overlaps, it
 * falls back to plain (non-highlighted) text rather than guess which cue's
 * timing should anchor the highlight.
 */
export function activeCues(cues: SubtitleCue[], currentTimeSeconds: number): SubtitleCue[] {
  return cues.filter((cue) => currentTimeSeconds >= cue.startSeconds && currentTimeSeconds < cue.endSeconds);
}

// ---------------------------------------------------------------------------
// Word-level highlight timing (see this file's header for the full design
// rationale - English-only, estimated by splitting a cue's own time window,
// never accumulating error across cues).
// ---------------------------------------------------------------------------

/** One word's estimated speaking window, always inside its parent cue's own
 * `[startSeconds, endSeconds)` - never anchored to anything else. */
export interface WordTiming {
  /** The word exactly as it appeared in the cue (punctuation attached, e.g.
   * `"there."`) - rendered verbatim so the highlighted text still matches
   * the subtitle. */
  word: string;
  startSeconds: number;
  endSeconds: number;
}

/** A word shorter than this many characters is still credited this much
 * weight - without a floor, one-letter words ("a", "I") would get almost no
 * screen time and the highlight would blink past them instead of tracking
 * speech a reader can follow. */
const MIN_WORD_WEIGHT = 3;

/** Extra weight credited to a word immediately followed by strong
 * punctuation - a speaker pauses there, so that word (and the silence after
 * it) legitimately occupies more of the cue's time window than its raw
 * length alone would suggest. */
const PAUSE_BONUS_WEIGHT = 2;

/** Strong punctuation implying a spoken pause - deliberately narrower than
 * "any punctuation" (e.g. excludes closing quotes/parens, which don't imply
 * a pause on their own). */
const PAUSE_PUNCTUATION_RE = /[.,!?—]$/;

/** A token with no letter/number in it at all - a bare dialogue dash
 * (`"- Hello"`, `"— Hello"`, the standard screenplay/subtitle convention for
 * marking a new speaker) or a lone em dash used as a line separator. Nobody
 * SPEAKS a dash - crediting it word-length weight (bug: it used to get
 * `max(1, MIN_WORD_WEIGHT)`, and even a PAUSE bonus on top since a bare `—`
 * also matches `PAUSE_PUNCTUATION_RE`) let it steal a large, visible share of
 * the cue's time from the words a viewer is actually reading. See
 * `wordWeight`, which zeroes these out instead. */
function isPunctuationOnly(token: string): boolean {
  return !/[\p{L}\p{N}]/u.test(token);
}

/**
 * Splits cue text into alternating whitespace/word tokens, preserving every
 * separator (spaces, newlines) verbatim - a renderer can rejoin these tokens
 * to reproduce the EXACT original layout while wrapping only the word tokens
 * for highlighting. The non-whitespace tokens here are exactly the words
 * `estimateWordTimings` produces timings for, in the same order, so a
 * renderer can walk both arrays in lockstep without a second, possibly
 * divergent, tokenization.
 */
export function tokenizeCueText(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

/** The word tokens only (no whitespace/newlines), in order. */
export function splitIntoWords(text: string): string[] {
  return tokenizeCueText(text).filter((token) => !/^\s+$/.test(token));
}

function wordWeight(word: string): number {
  // A bare dialogue dash isn't a spoken word - see `isPunctuationOnly`. Zero
  // weight means it claims none of the cue's time on its own (its "window"
  // collapses to the instant the NEXT real word starts, so it's effectively
  // skipped rather than highlighted) instead of stealing a
  // longer-than-any-real-word share the way a flat character-count weight
  // (plus the pause bonus a trailing `—` would ALSO have qualified for) did.
  if (isPunctuationOnly(word)) return 0;
  const base = Math.max(word.length, MIN_WORD_WEIGHT);
  return PAUSE_PUNCTUATION_RE.test(word) ? base + PAUSE_BONUS_WEIGHT : base;
}

/**
 * Estimates a per-word timing for one cue by dividing the cue's own
 * `[startSeconds, endSeconds)` window proportionally to each word's weight
 * (character count, floored at `MIN_WORD_WEIGHT`, plus `PAUSE_BONUS_WEIGHT`
 * for a word followed by strong punctuation) - see this file's header for
 * why this estimate, not real alignment, and why it never accumulates error
 * across cues (every call re-anchors to ITS OWN cue's start/end only).
 *
 * Guarantees, by construction:
 *  - Monotonic: word `i`'s end exactly equals word `i+1`'s start (both
 *    derived from the same running weight total), so the highlight only ever
 *    moves forward.
 *  - Never overruns the cue: the LAST word's `endSeconds` is pinned to the
 *    cue's own `endSeconds` exactly, sidestepping any floating-point drift
 *    from summing fractional shares across many words.
 */
export function estimateWordTimings(cue: SubtitleCue): WordTiming[] {
  const words = splitIntoWords(cue.text);
  if (words.length === 0) return [];

  const duration = Math.max(cue.endSeconds - cue.startSeconds, 0);
  if (duration === 0) {
    // Zero-duration cue (malformed VTT, or a line that only ever flashes) -
    // there is no time to spread across words. Collapse every word to the
    // cue's own single instant rather than divide by zero.
    return words.map((word) => ({ word, startSeconds: cue.startSeconds, endSeconds: cue.startSeconds }));
  }

  const rawWeights = words.map(wordWeight);
  const rawTotal = rawWeights.reduce((sum, weight) => sum + weight, 0);
  // Every "word" was punctuation-only (e.g. a cue that's just "— —" - rare,
  // but a real dialogue line can be nothing but a dash) - `rawTotal` would be
  // 0 and every division below would be `0/0`. Fall back to an even split
  // instead of producing NaN timings.
  const weights = rawTotal > 0 ? rawWeights : words.map(() => 1);
  const totalWeight = rawTotal > 0 ? rawTotal : weights.length;

  const timings: WordTiming[] = [];
  let elapsedWeight = 0;
  for (let i = 0; i < words.length; i += 1) {
    const startSeconds = cue.startSeconds + (elapsedWeight / totalWeight) * duration;
    elapsedWeight += weights[i];
    const isLastWord = i === words.length - 1;
    // Pin the last word's end to the cue's real end (see doc comment above)
    // instead of computing it from the running weight sum like every other
    // word - that sum SHOULD equal `totalWeight` exactly by the final
    // iteration, but floating-point summation across many fractional shares
    // is not guaranteed to land there.
    const endSeconds = isLastWord ? cue.endSeconds : cue.startSeconds + (elapsedWeight / totalWeight) * duration;
    timings.push({ word: words[i], startSeconds, endSeconds });
  }
  return timings;
}

/**
 * The index of the word active at `currentTimeSeconds` within `timings`
 * (assumed sorted/contiguous, as `estimateWordTimings` produces), or `-1`
 * before the first word starts. Searches from the end since the common
 * caller pattern is "this cue is already known to be active, which of its
 * words is it on" - the answer is usually near the end for a cue that's been
 * active a while, and this also naturally picks the LAST word when
 * `currentTimeSeconds` lands exactly on a zero-duration cue's single shared
 * instant (every word "starts" at once - see `estimateWordTimings`).
 */
export function activeWordIndex(timings: WordTiming[], currentTimeSeconds: number): number {
  for (let i = timings.length - 1; i >= 0; i -= 1) {
    if (currentTimeSeconds >= timings[i].startSeconds) return i;
  }
  return -1;
}
