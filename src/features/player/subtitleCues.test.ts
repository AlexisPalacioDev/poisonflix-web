import { describe, expect, it } from 'vitest';
import {
  activeCueText,
  activeCues,
  activeWordIndex,
  estimateWordTimings,
  parseVttCues,
  splitIntoWords,
  tokenizeCueText,
} from './subtitleCues';

describe('parseVttCues', () => {
  it('parses a basic single-cue VTT file (MM:SS.mmm timestamps)', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello there.\n';
    const cues = parseVttCues(vtt);
    expect(cues).toEqual([{ startSeconds: 1, endSeconds: 3.5, text: 'Hello there.' }]);
  });

  it('parses HH:MM:SS.mmm timestamps (hours group present)', () => {
    const vtt = 'WEBVTT\n\n01:02:03.000 --> 01:02:05.000\nLong movie line.\n';
    const cues = parseVttCues(vtt);
    expect(cues[0].startSeconds).toBe(3723);
    expect(cues[0].endSeconds).toBe(3725);
  });

  it('parses multiple cues in order', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'First.',
      '',
      '00:00:03.000 --> 00:00:04.000',
      'Second.',
      '',
    ].join('\n');
    const cues = parseVttCues(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('First.');
    expect(cues[1].text).toBe('Second.');
  });

  it('accepts a cue identifier line before the timing line', () => {
    const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nWith an id.\n';
    const cues = parseVttCues(vtt);
    expect(cues).toEqual([{ startSeconds: 1, endSeconds: 2, text: 'With an id.' }]);
  });

  it('strips markup tags (bold/italic, inline karaoke timestamps) down to plain text', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b>Bold</b> and <00:00:01.500><c>timed</c> word.\n';
    const cues = parseVttCues(vtt);
    expect(cues[0].text).toBe('Bold and timed word.');
  });

  it('joins multi-line cue text with newline', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLine one\nLine two\n';
    const cues = parseVttCues(vtt);
    expect(cues[0].text).toBe('Line one\nLine two');
  });

  it('handles CRLF line endings (observed from Jellyfin Stream.vtt)', () => {
    const vtt = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nCRLF line.\r\n';
    const cues = parseVttCues(vtt);
    expect(cues).toEqual([{ startSeconds: 1, endSeconds: 2, text: 'CRLF line.' }]);
  });

  it('skips NOTE/STYLE blocks and the WEBVTT header without throwing', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE This is a comment',
      '',
      'STYLE',
      '::cue { color: yellow; }',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Real cue.',
      '',
    ].join('\n');
    const cues = parseVttCues(vtt);
    expect(cues).toEqual([{ startSeconds: 1, endSeconds: 2, text: 'Real cue.' }]);
  });

  it('returns an empty array for an empty or header-only file', () => {
    expect(parseVttCues('')).toEqual([]);
    expect(parseVttCues('WEBVTT\n')).toEqual([]);
  });

  it('drops a cue whose text is empty after stripping markup', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c></c>\n';
    expect(parseVttCues(vtt)).toEqual([]);
  });
});

describe('activeCueText', () => {
  const cues = [
    { startSeconds: 1, endSeconds: 2, text: 'First' },
    { startSeconds: 5, endSeconds: 7, text: 'Second' },
  ];

  it('returns null when no cue is active at the given time', () => {
    expect(activeCueText(cues, 0)).toBeNull();
    expect(activeCueText(cues, 3)).toBeNull();
    expect(activeCueText(cues, 10)).toBeNull();
  });

  it('returns the active cue text within [start, end)', () => {
    expect(activeCueText(cues, 1)).toBe('First');
    expect(activeCueText(cues, 1.5)).toBe('First');
    // `end` itself is exclusive - the cue has already finished.
    expect(activeCueText(cues, 2)).toBeNull();
  });

  it('joins overlapping active cues with newline', () => {
    const overlapping = [
      { startSeconds: 1, endSeconds: 3, text: 'A' },
      { startSeconds: 2, endSeconds: 4, text: 'B' },
    ];
    expect(activeCueText(overlapping, 2.5)).toBe('A\nB');
  });
});

describe('activeCues', () => {
  it('returns the matching cue OBJECTS (not just text), same [start, end) window as activeCueText', () => {
    const cues = [
      { startSeconds: 1, endSeconds: 3, text: 'Hello there.' },
      { startSeconds: 5, endSeconds: 7, text: 'Second' },
    ];
    expect(activeCues(cues, 1.5)).toEqual([cues[0]]);
    expect(activeCues(cues, 4)).toEqual([]);
  });

  it('returns more than one cue for a legitimate overlap - callers decide what to do with that', () => {
    const overlapping = [
      { startSeconds: 1, endSeconds: 3, text: 'A' },
      { startSeconds: 2, endSeconds: 4, text: 'B' },
    ];
    expect(activeCues(overlapping, 2.5)).toEqual(overlapping);
  });
});

describe('tokenizeCueText / splitIntoWords', () => {
  it('splits on whitespace, keeping separators as their own tokens', () => {
    expect(tokenizeCueText('Hello there')).toEqual(['Hello', ' ', 'there']);
  });

  it('keeps newlines as their own token (multi-line cue text)', () => {
    expect(tokenizeCueText('Line one\nLine two')).toEqual(['Line', ' ', 'one', '\n', 'Line', ' ', 'two']);
  });

  it('returns an empty array for empty text', () => {
    expect(tokenizeCueText('')).toEqual([]);
  });

  it('splitIntoWords drops every whitespace/newline token, keeping only words in order', () => {
    expect(splitIntoWords('Line one\nLine two')).toEqual(['Line', 'one', 'Line', 'two']);
    expect(splitIntoWords('')).toEqual([]);
  });
});

describe('estimateWordTimings (word-level highlight estimation - see subtitleCues.ts header)', () => {
  it('a single-word cue: the one word spans the entire cue window', () => {
    const cue = { startSeconds: 0, endSeconds: 2, text: 'Hello' };
    expect(estimateWordTimings(cue)).toEqual([{ word: 'Hello', startSeconds: 0, endSeconds: 2 }]);
  });

  it('an empty cue produces no timings', () => {
    expect(estimateWordTimings({ startSeconds: 0, endSeconds: 2, text: '' })).toEqual([]);
  });

  it('many words: timings are contiguous (word i+1 starts exactly where word i ends) and never overrun the cue', () => {
    const cue = { startSeconds: 10, endSeconds: 14, text: 'Hi there friend today' };
    const timings = estimateWordTimings(cue);
    expect(timings).toHaveLength(4);
    expect(timings[0].startSeconds).toBe(cue.startSeconds);
    for (let i = 0; i < timings.length - 1; i += 1) {
      expect(timings[i].endSeconds).toBe(timings[i + 1].startSeconds);
    }
    // Never overruns the cue's own end - the last word is pinned exactly.
    expect(timings[timings.length - 1].endSeconds).toBe(cue.endSeconds);
    for (const t of timings) {
      expect(t.startSeconds).toBeGreaterThanOrEqual(cue.startSeconds);
      expect(t.endSeconds).toBeLessThanOrEqual(cue.endSeconds);
    }
  });

  it('a zero-duration cue collapses every word to the same single instant instead of dividing by zero', () => {
    const cue = { startSeconds: 5, endSeconds: 5, text: 'Hi there' };
    expect(estimateWordTimings(cue)).toEqual([
      { word: 'Hi', startSeconds: 5, endSeconds: 5 },
      { word: 'there', startSeconds: 5, endSeconds: 5 },
    ]);
  });

  it('multi-line cue text: words are timed across BOTH lines in reading order', () => {
    const cue = { startSeconds: 0, endSeconds: 4, text: 'Line one\nLine two' };
    const timings = estimateWordTimings(cue);
    expect(timings.map((t) => t.word)).toEqual(['Line', 'one', 'Line', 'two']);
    expect(timings[0].startSeconds).toBe(0);
    expect(timings[timings.length - 1].endSeconds).toBe(4);
  });

  it('a word before strong punctuation (a spoken pause) gets a larger share than an equal-length word without it', () => {
    // Same total text length either way; only the trailing "." differs.
    const withoutPause = estimateWordTimings({ startSeconds: 0, endSeconds: 8, text: 'abcd efgh' });
    const withPause = estimateWordTimings({ startSeconds: 0, endSeconds: 8, text: 'abcd. efgh' });

    const firstWordDuration = (timings: { startSeconds: number; endSeconds: number }[]) =>
      timings[0].endSeconds - timings[0].startSeconds;

    expect(firstWordDuration(withPause)).toBeGreaterThan(firstWordDuration(withoutPause));
  });

  it('a very short word (below the minimum weight floor) still gets a visible, non-blink share of time', () => {
    const cue = { startSeconds: 0, endSeconds: 10, text: 'a much longer word here' };
    const timings = estimateWordTimings(cue);
    const aDuration = timings[0].endSeconds - timings[0].startSeconds;
    // Not a blink: comfortably more than a tenth of a second for a 10s cue.
    expect(aDuration).toBeGreaterThan(0.5);
  });

  // Bug fix (challenger audit): a bare dialogue dash ("- Hello", the
  // standard screenplay/subtitle convention for a new speaker) used to be
  // credited word-length weight - and even the punctuation PAUSE bonus,
  // since a lone "—" also matches `PAUSE_PUNCTUATION_RE` - stealing a large,
  // visible share of the cue's time from the words actually being read.
  it('a bare dialogue dash gets ZERO weight - it is not a spoken word', () => {
    const cue = { startSeconds: 0, endSeconds: 10, text: '- Hello there' };
    const timings = estimateWordTimings(cue);
    const dash = timings[0];
    expect(dash.word).toBe('-');
    // Zero share of the cue's time - collapsed to the instant the next
    // (real) word starts, not a visible highlighted window of its own.
    expect(dash.endSeconds - dash.startSeconds).toBe(0);
  });

  it('activeWordIndex skips a zero-weight dash and lands on the first real word instead', () => {
    const cue = { startSeconds: 0, endSeconds: 10, text: '- Hello there' };
    const timings = estimateWordTimings(cue);
    // At the cue's very start, the dash's window is zero-width - the active
    // word must be "Hello" (index 1), never the dash (index 0).
    expect(activeWordIndex(timings, cue.startSeconds)).toBe(1);
  });

  it('a cue made ENTIRELY of punctuation-only tokens falls back to an even split instead of dividing by zero', () => {
    const cue = { startSeconds: 0, endSeconds: 4, text: '— -' };
    const timings = estimateWordTimings(cue);
    expect(timings).toHaveLength(2);
    for (const t of timings) {
      expect(Number.isFinite(t.startSeconds)).toBe(true);
      expect(Number.isFinite(t.endSeconds)).toBe(true);
      expect(t.startSeconds).toBeGreaterThanOrEqual(cue.startSeconds);
      expect(t.endSeconds).toBeLessThanOrEqual(cue.endSeconds);
    }
    expect(timings[0].endSeconds).toBe(timings[1].startSeconds);
    expect(timings[1].endSeconds).toBe(cue.endSeconds);
  });
});

describe('activeWordIndex', () => {
  const timings = [
    { word: 'Hi', startSeconds: 0, endSeconds: 1 },
    { word: 'there', startSeconds: 1, endSeconds: 2.5 },
    { word: 'friend', startSeconds: 2.5, endSeconds: 4 },
  ];

  it('returns -1 before the first word starts', () => {
    expect(activeWordIndex(timings, -1)).toBe(-1);
  });

  it('returns the index of the word whose window contains currentTimeSeconds', () => {
    expect(activeWordIndex(timings, 0)).toBe(0);
    expect(activeWordIndex(timings, 0.5)).toBe(0);
    expect(activeWordIndex(timings, 1.2)).toBe(1);
    expect(activeWordIndex(timings, 3.9)).toBe(2);
  });

  it('a zero-duration cue (every word sharing one instant) resolves to the LAST word', () => {
    const sameInstant = [
      { word: 'Hi', startSeconds: 5, endSeconds: 5 },
      { word: 'there', startSeconds: 5, endSeconds: 5 },
    ];
    expect(activeWordIndex(sameInstant, 5)).toBe(1);
  });

  it('returns -1 for an empty timings array', () => {
    expect(activeWordIndex([], 1)).toBe(-1);
  });
});
