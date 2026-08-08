import { describe, expect, it } from 'vitest';
import { activeCueText, parseVttCues } from './subtitleCues';

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
