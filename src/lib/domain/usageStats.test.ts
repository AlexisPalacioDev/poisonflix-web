import { describe, expect, it } from 'vitest';
import {
  dailyPlays,
  estimateListeningMinutes,
  formatMinutes,
  playbackEvents,
  topArtists,
  topTracks,
  usageByUser,
} from './usageStats';
import type { ActivityEntry, JellyfinItem, JellyfinUser } from '../../api/schemas/jellyfin';

const USERS: JellyfinUser[] = [
  { Id: 'u1', Name: 'perroenvenenado' },
  { Id: 'u2', Name: 'invitado' },
];

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    Id: 1,
    Name: 'x',
    Type: 'AudioPlaybackStopped',
    ItemId: 'item-1',
    Date: '2026-07-26T12:00:00.0000000Z',
    UserId: 'u1',
    Severity: 'Information',
    ...over,
  } as ActivityEntry;
}

function audio(over: Partial<JellyfinItem>): JellyfinItem {
  return { Id: 'a1', Name: 'Track', Artists: ['The Band'], ...over } as JellyfinItem;
}

describe('playbackEvents', () => {
  it('counts finished playbacks and classifies audio vs video', () => {
    const events = playbackEvents([
      entry({ Type: 'AudioPlaybackStopped' }),
      entry({ Type: 'VideoPlaybackStopped' }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(['audio', 'video']);
  });

  it('ignores starts, so an abandoned play is not counted twice', () => {
    const events = playbackEvents([
      entry({ Type: 'AudioPlaybackStarted' }),
      entry({ Type: 'AudioPlaybackStopped' }),
    ]);
    expect(events).toHaveLength(1);
  });

  it('ignores non-playback noise like logins', () => {
    expect(playbackEvents([entry({ Type: 'SessionStarted' })])).toEqual([]);
    expect(playbackEvents([entry({ Type: 'AuthenticationSucceeded' })])).toEqual([]);
  });

  it('drops entries with no user — this is a per-user monitor', () => {
    expect(playbackEvents([entry({ UserId: null })])).toEqual([]);
  });

  it('drops an unparseable date instead of poisoning the buckets with NaN', () => {
    expect(playbackEvents([entry({ Date: 'not-a-date' })])).toEqual([]);
  });
});

describe('usageByUser', () => {
  it('totals per user, busiest first, with names resolved', () => {
    const rows = usageByUser(
      playbackEvents([
        entry({ UserId: 'u2', Type: 'VideoPlaybackStopped' }),
        entry({ UserId: 'u1' }),
        entry({ UserId: 'u1', Type: 'VideoPlaybackStopped' }),
      ]),
      USERS,
    );
    expect(rows.map((r) => r.name)).toEqual(['perroenvenenado', 'invitado']);
    expect(rows[0]).toMatchObject({ audioPlays: 1, videoPlays: 1, totalPlays: 2 });
  });

  it('keeps activity from a user that no longer exists rather than under-reporting', () => {
    const rows = usageByUser(playbackEvents([entry({ UserId: 'ghost-1234567890' })]), USERS);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain('ghost');
  });

  it('tracks the most recent activity per user', () => {
    const rows = usageByUser(
      playbackEvents([
        entry({ Date: '2026-07-20T10:00:00Z' }),
        entry({ Date: '2026-07-25T10:00:00Z' }),
      ]),
      USERS,
    );
    expect(rows[0].lastActivity?.toISOString()).toBe('2026-07-25T10:00:00.000Z');
  });
});

describe('dailyPlays', () => {
  const now = new Date('2026-07-26T12:00:00Z');

  it('buckets by day with the newest bucket last', () => {
    const buckets = dailyPlays(
      playbackEvents([
        entry({ Date: '2026-07-26T09:00:00Z' }),
        entry({ Date: '2026-07-26T11:00:00Z' }),
        entry({ Date: '2026-07-25T09:00:00Z' }),
      ]),
      3,
      now,
    );
    expect(buckets).toEqual([0, 1, 2]);
  });

  it('ignores anything older than the window', () => {
    const buckets = dailyPlays(playbackEvents([entry({ Date: '2026-01-01T00:00:00Z' })]), 3, now);
    expect(buckets).toEqual([0, 0, 0]);
  });
});

describe('top lists', () => {
  const items = [
    audio({ Id: 'a', Name: 'One', Artists: ['A'], UserData: { PlayCount: 5 } }),
    audio({ Id: 'b', Name: 'Two', Artists: ['A'], UserData: { PlayCount: 3 } }),
    audio({ Id: 'c', Name: 'Three', Artists: ['B'], UserData: { PlayCount: 4 } }),
    audio({ Id: 'd', Name: 'Never', Artists: ['C'], UserData: { PlayCount: 0 } }),
  ] as JellyfinItem[];

  it('sums an artist across their tracks', () => {
    expect(topArtists(items)).toEqual([
      { label: 'A', plays: 8 },
      { label: 'B', plays: 4 },
    ]);
  });

  it('never lists something that was never played', () => {
    expect(topArtists(items).map((e) => e.label)).not.toContain('C');
    expect(topTracks(items).map((e) => e.label)).not.toContain('Never');
  });

  it('ranks tracks by play count and keeps the artist as a subtitle', () => {
    const top = topTracks(items);
    expect(top[0]).toMatchObject({ label: 'One', plays: 5, detail: 'A' });
  });

  it('respects the limit', () => {
    expect(topTracks(items, 1)).toHaveLength(1);
  });
});

describe('estimateListeningMinutes', () => {
  // 3 minutes in ticks (10_000_000 ticks per second).
  const threeMinutes = 3 * 60 * 10_000_000;

  it('multiplies each track length by how often it was played', () => {
    const minutes = estimateListeningMinutes([
      audio({ RunTimeTicks: threeMinutes, UserData: { PlayCount: 4 } }),
    ] as JellyfinItem[]);
    expect(minutes).toBe(12);
  });

  it('contributes nothing for a track with no known runtime, rather than guessing', () => {
    const minutes = estimateListeningMinutes([
      audio({ RunTimeTicks: null, UserData: { PlayCount: 10 } }),
    ] as JellyfinItem[]);
    expect(minutes).toBe(0);
  });
});

describe('formatMinutes', () => {
  it('reads as minutes under an hour and h+m above', () => {
    expect(formatMinutes(31)).toBe('31m');
    expect(formatMinutes(492)).toBe('8h 12m');
    expect(formatMinutes(120)).toBe('2h 0m');
  });
});
