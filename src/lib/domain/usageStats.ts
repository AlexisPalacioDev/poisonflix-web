import type { ActivityEntry, JellyfinItem, JellyfinUser } from '../../api/schemas/jellyfin';

// Pure rules behind the usage monitor. Two different questions, two different
// sources, and it matters that they stay separate:
//
//  - "who used the server, when"  -> the activity log. A rolling timeline of
//    playback events, so it answers *lately*, never *ever*.
//  - "what does someone listen to" -> per-user UserData (PlayCount). Totals
//    since forever, but with no dates attached.
//
// Mixing them would produce a number that is neither, so nothing here does.

const TICKS_PER_MINUTE = 600_000_000;

export type MediaKind = 'audio' | 'video';

export interface PlaybackEvent {
  userId: string;
  kind: MediaKind;
  date: Date;
}

/**
 * Keeps only *finished* playbacks (…PlaybackStopped) and tags each audio/video.
 *
 * Stopped rather than Started: a start that was abandoned after four seconds
 * isn't usage, and counting both would double every play. Entries with no user
 * (server-level events) are dropped — this is a per-user monitor.
 */
export function playbackEvents(entries: ActivityEntry[]): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  for (const entry of entries) {
    const type = entry.Type ?? '';
    if (!type.endsWith('PlaybackStopped')) continue;
    if (!entry.UserId) continue;
    const date = new Date(entry.Date);
    if (Number.isNaN(date.getTime())) continue;
    events.push({
      userId: entry.UserId,
      kind: type.startsWith('Audio') ? 'audio' : 'video',
      date,
    });
  }
  return events;
}

export interface UserUsage {
  userId: string;
  name: string;
  audioPlays: number;
  videoPlays: number;
  totalPlays: number;
  lastActivity: Date | null;
}

/** Per-user totals over whatever window the caller pulled, busiest first. */
export function usageByUser(events: PlaybackEvent[], users: JellyfinUser[]): UserUsage[] {
  const names = new Map(users.map((user) => [user.Id, user.Name]));
  const byUser = new Map<string, UserUsage>();

  for (const event of events) {
    let row = byUser.get(event.userId);
    if (!row) {
      row = {
        userId: event.userId,
        // A user deleted since the log entry was written still has activity in
        // it; showing the raw id beats dropping the row and under-reporting.
        name: names.get(event.userId) ?? `Usuario ${event.userId.slice(0, 8)}`,
        audioPlays: 0,
        videoPlays: 0,
        totalPlays: 0,
        lastActivity: null,
      };
      byUser.set(event.userId, row);
    }
    if (event.kind === 'audio') row.audioPlays += 1;
    else row.videoPlays += 1;
    row.totalPlays += 1;
    if (!row.lastActivity || event.date > row.lastActivity) row.lastActivity = event.date;
  }

  return [...byUser.values()].sort((a, b) => b.totalPlays - a.totalPlays);
}

/**
 * Plays per day, oldest bucket first, for a sparkline. `now` is injected rather
 * than read from the clock so the buckets are deterministic under test.
 */
export function dailyPlays(events: PlaybackEvent[], days: number, now: Date): number[] {
  const buckets = new Array<number>(days).fill(0);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const event of events) {
    const age = Math.floor((now.getTime() - event.date.getTime()) / dayMs);
    if (age < 0 || age >= days) continue;
    buckets[days - 1 - age] += 1;
  }
  return buckets;
}

export interface TopEntry {
  label: string;
  plays: number;
  /** Present for tracks, absent for artists — lets the UI show a subtitle. */
  detail?: string | null;
}

function itemArtist(item: JellyfinItem): string | null {
  return item.Artists?.[0] ?? item.AlbumArtist ?? null;
}

/** Top artists by summed PlayCount across their tracks. */
export function topArtists(items: JellyfinItem[], limit = 5): TopEntry[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    const artist = itemArtist(item);
    if (!artist) continue;
    totals.set(artist, (totals.get(artist) ?? 0) + (item.UserData?.PlayCount ?? 0));
  }
  return [...totals.entries()]
    .filter(([, plays]) => plays > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, plays]) => ({ label, plays }));
}

/** Top tracks by PlayCount. */
export function topTracks(items: JellyfinItem[], limit = 5): TopEntry[] {
  return items
    .filter((item) => (item.UserData?.PlayCount ?? 0) > 0)
    .sort((a, b) => (b.UserData?.PlayCount ?? 0) - (a.UserData?.PlayCount ?? 0))
    .slice(0, limit)
    .map((item) => ({
      label: item.Name,
      plays: item.UserData?.PlayCount ?? 0,
      detail: itemArtist(item),
    }));
}

/**
 * Listening time in minutes, ESTIMATED as play count x track length.
 *
 * It is an estimate and the UI must say so: Jellyfin stores no per-play
 * duration, so a track skipped after ten seconds counts the same as one played
 * through. Tracks with no runtime contribute nothing rather than a guess.
 */
export function estimateListeningMinutes(items: JellyfinItem[]): number {
  let ticks = 0;
  for (const item of items) {
    const runtime = item.RunTimeTicks ?? 0;
    ticks += runtime * (item.UserData?.PlayCount ?? 0);
  }
  return Math.round(ticks / TICKS_PER_MINUTE);
}

/** "8h 12m" / "31m" — compact enough for a stat tile. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
