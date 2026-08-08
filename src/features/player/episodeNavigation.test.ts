import { describe, expect, it } from 'vitest';
import { type EpisodeNavItem, nextEpisode, previousEpisode, sortEpisodes } from './episodeNavigation';

// Pure-function coverage for the player's prev/next/jump episode navigation
// (owner request). Component-level wiring (buttons only on Episode items,
// disabled state, selecting navigates to the right id) lives in
// VideoSurface.test.tsx / PlayerScreen.test.tsx instead - these tests only
// exercise the ordering/boundary logic those components rely on.

// `imageTag: null` stands for an episode with no still frame - the ordering
// logic under test never reads it, but the field is required so that a new
// call site cannot forget to carry an episode's artwork through.
const s1e1: EpisodeNavItem = { id: 'ep-1-1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot', imageTag: null };
const s1e2: EpisodeNavItem = { id: 'ep-1-2', seasonNumber: 1, episodeNumber: 2, title: 'Second', imageTag: null };
const s1e3: EpisodeNavItem = { id: 'ep-1-3', seasonNumber: 1, episodeNumber: 3, title: 'Finale', imageTag: null };
const s2e1: EpisodeNavItem = { id: 'ep-2-1', seasonNumber: 2, episodeNumber: 1, title: 'Return', imageTag: null };

describe('sortEpisodes', () => {
  it('orders by (season, episode) ascending regardless of input order', () => {
    const shuffled = [s2e1, s1e3, s1e1, s1e2];
    expect(sortEpisodes(shuffled)).toEqual([s1e1, s1e2, s1e3, s2e1]);
  });

  it('does not mutate the input array', () => {
    const input = [s1e3, s1e1];
    const copy = [...input];
    sortEpisodes(input);
    expect(input).toEqual(copy);
  });
});

describe('previousEpisode / nextEpisode', () => {
  const sorted = sortEpisodes([s1e1, s1e2, s1e3, s2e1]);

  it('walks backward/forward within the same season', () => {
    expect(previousEpisode(sorted, s1e2.id)).toEqual(s1e1);
    expect(nextEpisode(sorted, s1e2.id)).toEqual(s1e3);
  });

  it('crosses a season boundary: last of S1 -> next is first of S2', () => {
    expect(nextEpisode(sorted, s1e3.id)).toEqual(s2e1);
    expect(previousEpisode(sorted, s2e1.id)).toEqual(s1e3);
  });

  it('the first episode has no previous', () => {
    expect(previousEpisode(sorted, s1e1.id)).toBeNull();
  });

  it('the last episode has no next', () => {
    expect(nextEpisode(sorted, s2e1.id)).toBeNull();
  });

  it('returns null for an id not present in the list', () => {
    expect(previousEpisode(sorted, 'unknown')).toBeNull();
    expect(nextEpisode(sorted, 'unknown')).toBeNull();
  });
});
