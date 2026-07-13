import { describe, it, expect } from 'vitest';
import { summarizeAvailability, type ReleaseCandidate } from './availability';

const rel = (title: string, seeders: number, tmdbId?: number): ReleaseCandidate => ({
  title,
  seeders,
  tmdbId,
});

describe('summarizeAvailability', () => {
  it('reports not found for an empty result set', () => {
    const s = summarizeAvailability([]);
    expect(s.found).toBe(false);
    expect(s.totalReleases).toBe(0);
    expect(s.languages).toEqual([]);
  });

  it('aggregates count and max seeders across releases', () => {
    const s = summarizeAvailability([
      rel('Movie 1080p BluRay x264', 100),
      rel('Movie 720p WEB-DL', 40),
    ]);
    expect(s.found).toBe(true);
    expect(s.totalReleases).toBe(2);
    expect(s.maxSeeders).toBe(100);
  });

  it('breaks down languages sorted by seeder health', () => {
    const s = summarizeAvailability([
      rel('Movie 1080p Latino x265', 20),
      rel('Movie 1080p BluRay x264', 300), // English (unmarked)
      rel('Movie 720p Latino WEB', 5),
    ]);
    expect(s.languages[0].language).toBe('english');
    expect(s.languages[0].maxSeeders).toBe(300);
    const latino = s.languages.find((l) => l.language === 'spanish-latino');
    expect(latino?.count).toBe(2);
    expect(latino?.maxSeeders).toBe(20);
  });

  it('keeps releases with a matching tmdbId', () => {
    const s = summarizeAvailability([rel('Movie 1080p', 10, 42)], { tmdbId: 42 });
    expect(s.totalReleases).toBe(1);
  });

  it('drops releases whose reported tmdbId is a different title', () => {
    const s = summarizeAvailability(
      [rel('Wrong Movie 1080p', 999, 7), rel('Right Movie 1080p', 10, 42)],
      { tmdbId: 42 },
    );
    expect(s.totalReleases).toBe(1);
    expect(s.maxSeeders).toBe(10);
  });

  it('keeps id-less releases even when a target id is given', () => {
    const s = summarizeAvailability([rel('Movie 1080p', 50, 0)], { tmdbId: 42 });
    expect(s.totalReleases).toBe(1);
  });
});
