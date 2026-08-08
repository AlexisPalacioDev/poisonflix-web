import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubtitleCue } from './subtitleCues';
import {
  __resetWordTimingsCacheForTests,
  fetchWordTimingsData,
  resolveWordTimingsForCue,
  type WordTimingsFile,
} from './wordTimingsSource';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function notOkResponse(status: number, jsonSpy: () => Promise<unknown>): Response {
  return { ok: false, status, json: jsonSpy } as unknown as Response;
}

const validFile: WordTimingsFile = {
  v: 1,
  item: 'item-1',
  track: 5,
  cues: [{ t: 746.16, w: [[20, 440], [480, 560], [620, 800]] }],
};

beforeEach(() => {
  __resetWordTimingsCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetWordTimingsCacheForTests();
});

describe('fetchWordTimingsData (client fetch/validate/cache - wordTimingsSource.ts)', () => {
  it('resolves the parsed file when the fetch succeeds and the body matches the schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validFile)));
    const result = await fetchWordTimingsData('item-1');
    expect(result).toEqual(validFile);
  });

  it('resolves null on a 404 - the NORMAL case for most titles, not an error', async () => {
    // A real assertion for "never reads the body of a non-2xx response" (not
    // just a call-count on `fetch` itself, which would pass either way) -
    // `jsonSpy` would reject if it were ever invoked, proving `.json()` is
    // never called on this response.
    const jsonSpy = vi.fn(() => Promise.reject(new Error('should not be called')));
    const fetchMock = vi.fn().mockResolvedValue(notOkResponse(404, jsonSpy));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchWordTimingsData('item-without-data');
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('resolves null when `v` is anything other than the one contract version this client understands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...validFile, v: 2 })));
    const result = await fetchWordTimingsData('item-1');
    expect(result).toBeNull();
  });

  it('resolves null when the response body is not valid JSON (corrupt payload)', async () => {
    const brokenResponse = { ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token')) } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(brokenResponse));
    const result = await fetchWordTimingsData('item-1');
    expect(result).toBeNull();
  });

  it('resolves null when the JSON is well-formed but does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' })));
    const result = await fetchWordTimingsData('item-1');
    expect(result).toBeNull();
  });

  it('resolves null and ignores the whole file when `item` does not match the requested id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...validFile, item: 'some-other-item' })));
    const result = await fetchWordTimingsData('item-1');
    expect(result).toBeNull();
  });

  it('resolves null (never rejects) when the network request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchWordTimingsData('item-1')).resolves.toBeNull();
  });

  it('caches per item - a second call for the same item does not re-fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validFile));
    vi.stubGlobal('fetch', fetchMock);
    await fetchWordTimingsData('item-1');
    await fetchWordTimingsData('item-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache across different items - a different id triggers its own fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validFile));
    vi.stubGlobal('fetch', fetchMock);
    await fetchWordTimingsData('item-1');
    await fetchWordTimingsData('item-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT remember a FAILED attempt forever - a later call for the same item retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // transient network blip
      .mockResolvedValueOnce(jsonResponse(validFile)); // the same item, moments later, works
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWordTimingsData('item-1')).resolves.toBeNull();
    await expect(fetchWordTimingsData('item-1')).resolves.toEqual(validFile);
    expect(fetchMock).toHaveBeenCalledTimes(2); // the second call was a REAL retry, not a cache hit
  });

  it('DOES remember a SUCCESSFUL fetch forever - a later call reuses it, not just an immediately-following one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validFile));
    vi.stubGlobal('fetch', fetchMock);
    await fetchWordTimingsData('item-1');
    await fetchWordTimingsData('item-1');
    await fetchWordTimingsData('item-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveWordTimingsForCue (matching against the parsed VTT cue - wordTimingsSource.ts)', () => {
  const cue: SubtitleCue = { startSeconds: 746.16, endSeconds: 749.0, text: 'Hi there friend' };

  it('returns null when there is no file at all', () => {
    expect(resolveWordTimingsForCue(null, cue, 5)).toBeNull();
  });

  it('returns null when the file is for a DIFFERENT subtitle track than the one being watched', () => {
    expect(resolveWordTimingsForCue(validFile, cue, 6)).toBeNull();
  });

  it('returns null when no cue in the file matches this one\'s startSeconds within tolerance', () => {
    const cueFarAway: SubtitleCue = { ...cue, startSeconds: 900 };
    expect(resolveWordTimingsForCue(validFile, cueFarAway, 5)).toBeNull();
  });

  it('returns null when the matched cue\'s word count does not equal this cue\'s word count (subtitle changed since generation)', () => {
    const cueWithExtraWord: SubtitleCue = { ...cue, text: 'Hi there my friend' };
    expect(resolveWordTimingsForCue(validFile, cueWithExtraWord, 5)).toBeNull();
  });

  it('converts matched ms offsets (relative to the cue) into absolute seconds, in word order', () => {
    const result = resolveWordTimingsForCue(validFile, cue, 5);
    expect(result).toEqual([
      { word: 'Hi', startSeconds: 746.16 + 0.02, endSeconds: 746.16 + 0.44 },
      { word: 'there', startSeconds: 746.16 + 0.48, endSeconds: 746.16 + 0.56 },
      { word: 'friend', startSeconds: 746.16 + 0.62, endSeconds: 746.16 + 0.8 },
    ]);
  });

  it('tolerates a small rounding difference between the file\'s `t` and the VTT\'s own startSeconds', () => {
    const nearlyMatchingCue: SubtitleCue = { ...cue, startSeconds: 746.17 }; // 10ms off
    const result = resolveWordTimingsForCue(validFile, nearlyMatchingCue, 5);
    expect(result).not.toBeNull();
    expect(result?.[0].word).toBe('Hi');
  });

  it('rejects a cue just OUTSIDE the tolerance window - the boundary is enforced tightly, not loosely', () => {
    // Tolerance is 0.05s; 0.2s off is well outside it but still close enough
    // that a much wider (buggy) tolerance would wrongly accept it.
    const justOutsideTolerance: SubtitleCue = { ...cue, startSeconds: 746.16 + 0.2 };
    expect(resolveWordTimingsForCue(validFile, justOutsideTolerance, 5)).toBeNull();
  });

  it('picks the NEAREST matching cue when more than one falls within tolerance, not just the first', () => {
    const fileWithTwoCloseCues: WordTimingsFile = {
      v: 1,
      item: 'item-1',
      track: 5,
      cues: [
        // Listed FIRST but farther from the queried cue's startSeconds.
        { t: 746.14, w: [[0, 1000], [1000, 2000], [2000, 2840]] },
        // Listed SECOND but the actually-nearest match.
        { t: 746.16, w: [[20, 440], [480, 560], [620, 800]] },
      ],
    };
    const result = resolveWordTimingsForCue(fileWithTwoCloseCues, cue, 5);
    // Only the SECOND (nearer) cue's offsets produce this exact boundary.
    expect(result?.[0]).toEqual({ word: 'Hi', startSeconds: 746.16 + 0.02, endSeconds: 746.16 + 0.44 });
  });

  it('rejects offsets that are clearly ABSOLUTE (not relative to the cue) instead of applying them verbatim', () => {
    // A cue starting at 746.16s with `w` offsets that look like ABSOLUTE
    // seconds-since-epoch-ish large millisecond values, wildly exceeding the
    // cue's own ~2.8s duration - a real generator bug this client must not
    // silently trust.
    const fileWithAbsoluteOffsets: WordTimingsFile = {
      v: 1,
      item: 'item-1',
      track: 5,
      cues: [{ t: 746.16, w: [[746160, 746600], [746640, 746720], [746780, 746960]] }],
    };
    expect(resolveWordTimingsForCue(fileWithAbsoluteOffsets, cue, 5)).toBeNull();
  });

  it('rejects offsets with a meaningfully NEGATIVE start', () => {
    const fileWithNegativeOffset: WordTimingsFile = {
      v: 1,
      item: 'item-1',
      track: 5,
      cues: [{ t: 746.16, w: [[-500, 440], [480, 560], [620, 800]] }],
    };
    expect(resolveWordTimingsForCue(fileWithNegativeOffset, cue, 5)).toBeNull();
  });

  it('rejects offsets where a word\'s end comes before its own start', () => {
    const fileWithBackwardsOffset: WordTimingsFile = {
      v: 1,
      item: 'item-1',
      track: 5,
      cues: [{ t: 746.16, w: [[20, 440], [560, 480], [620, 800]] }],
    };
    expect(resolveWordTimingsForCue(fileWithBackwardsOffset, cue, 5)).toBeNull();
  });

  it('rejects offsets that run past the cue\'s own end', () => {
    const fileWithOverrunningOffset: WordTimingsFile = {
      v: 1,
      item: 'item-1',
      track: 5,
      // cue duration is 2840ms (746.16 -> 749.0); this word claims to end at
      // 5000ms into the cue, well past it.
      cues: [{ t: 746.16, w: [[20, 440], [480, 560], [620, 5000]] }],
    };
    expect(resolveWordTimingsForCue(fileWithOverrunningOffset, cue, 5)).toBeNull();
  });
});
