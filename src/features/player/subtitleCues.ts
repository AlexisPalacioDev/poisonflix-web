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
// enough not to justify pulling one in. Word-by-word highlighting is
// explicitly OUT OF SCOPE for this change (owner instruction) - this module
// only ever produces plain cue text.

export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  /** Cue text with VTT markup tags stripped (`<b>`, `<i>`, inline
   *  `<00:00:01.000>` karaoke timestamps, `<c.classname>`, etc.) - kept as
   *  plain text since word-level highlighting is out of scope. */
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
 * down to plain text - this change never highlights individual words, so
 * there is nothing for these tags to drive here. */
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
  const active = cues.filter(
    (cue) => currentTimeSeconds >= cue.startSeconds && currentTimeSeconds < cue.endSeconds,
  );
  if (active.length === 0) return null;
  return active.map((cue) => cue.text).join('\n');
}
