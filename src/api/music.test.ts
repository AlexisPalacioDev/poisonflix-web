import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/http/client';
import { normalizeMusicSource, warmMusicTrack } from './music';

// `/bff/music/warm` is fire-and-forget cache warming (mobile-music-overhaul:
// warm-search-results / warm-next-track). These assert the client's two
// promises: it never surfaces a failure, and it never asks twice for the
// same videoId+depth in one session.

vi.mock('../lib/http/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

describe('warmMusicTrack', () => {
  afterEach(() => {
    mockedApiFetch.mockReset();
  });

  it('POSTs the videoId, source and depth to /music/warm', () => {
    mockedApiFetch.mockResolvedValueOnce(undefined);

    warmMusicTrack('vid-1', 'ytmusic', 'url');

    expect(mockedApiFetch).toHaveBeenCalledWith('bff', '/music/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid-1', source: 'ytmusic', depth: 'url' }),
    });
  });

  it('does not ask twice for the same videoId at the same depth', () => {
    mockedApiFetch.mockResolvedValue(undefined);

    warmMusicTrack('vid-2', 'auto', 'url');
    warmMusicTrack('vid-2', 'auto', 'url');

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('asks again for the same videoId at a different depth — url and full warm different work', () => {
    mockedApiFetch.mockResolvedValue(undefined);

    warmMusicTrack('vid-3', 'auto', 'url');
    warmMusicTrack('vid-3', 'auto', 'full');

    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('asks again for the same videoId and depth when the source differs — the worker cache is keyed on videoId alone, so the wrong source must not be silently dropped', () => {
    mockedApiFetch.mockResolvedValue(undefined);

    warmMusicTrack('vid-5', 'auto', 'url');
    warmMusicTrack('vid-5', 'ytmusic', 'url');

    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('is best-effort: a rejected request never throws and never rejects', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('502 from a stale yt-dlp resolve'));

    expect(() => warmMusicTrack('vid-4', 'auto', 'url')).not.toThrow();
    // Let the swallowed rejection's microtask settle before the test ends —
    // an unhandled one would otherwise surface as a global test failure.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('normalizeMusicSource', () => {
  it('passes through the two explicit worker sources', () => {
    expect(normalizeMusicSource('ytmusic')).toBe('ytmusic');
    expect(normalizeMusicSource('youtube')).toBe('youtube');
  });

  it('falls back to auto for anything else, including null/undefined', () => {
    expect(normalizeMusicSource(null)).toBe('auto');
    expect(normalizeMusicSource(undefined)).toBe('auto');
    expect(normalizeMusicSource('something-else')).toBe('auto');
  });
});
