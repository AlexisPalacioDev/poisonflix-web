import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicResultItem, MusicSongResult } from '../../api/schemas/music';

// Turning "what this user played" into "what to show them", the way YouTube
// Music's home works: a handful of *seeds* drawn from the history, each opening
// a row of related tracks ("Porque escuchaste X"), plus one merged mix.
//
// Everything here is pure so the rules that shape the feed — how many artists
// it spans, what it refuses to repeat — are testable without a server.

/** How many history tracks become their own "Porque escuchaste…" row. */
export const MAX_SEEDS = 3;

export function trackArtist(item: JellyfinItem): string | null {
  return item.Artists?.[0] ?? item.AlbumArtist ?? null;
}

/**
 * Picks the seed tracks a feed is built from, newest first, **one per artist**.
 *
 * The artist rule is the whole point. A play history is lopsided — a night on
 * repeat with one band buries everything else — and seeding three rows off the
 * same artist would return three near-identical rows. Spreading the seeds is
 * what makes the feed feel like it knows you rather than like it knows your
 * last hour.
 */
export function pickSeedTracks(history: JellyfinItem[], max = MAX_SEEDS): JellyfinItem[] {
  const seeds: JellyfinItem[] = [];
  const seenArtists = new Set<string>();
  for (const item of history) {
    if (seeds.length >= max) break;
    const artist = trackArtist(item);
    // An unknown artist can't be shown to be a duplicate, so it's allowed
    // through rather than silently dropping the only history a user has.
    const key = artist?.toLowerCase() ?? `__unknown-${item.Id}`;
    if (seenArtists.has(key)) continue;
    seenArtists.add(key);
    seeds.push(item);
  }
  return seeds;
}

/** Songs only: a radio feed can carry albums and playlists too. */
export function songsOnly(items: MusicResultItem[]): MusicSongResult[] {
  return items.filter((item): item is MusicSongResult => item.type === 'song');
}

/**
 * Interleaves the per-seed radios into one mix, round-robin, dropping repeats.
 *
 * Round-robin rather than concatenation: taking one track from each seed in
 * turn keeps every taste the user has represented at the *top* of the mix,
 * where they'll actually see it. Concatenating would bury the second and third
 * artist below a full row of the first.
 */
export function interleave(rows: MusicSongResult[][], limit: number): MusicSongResult[] {
  const mixed: MusicSongResult[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...rows.map((row) => row.length));
  for (let i = 0; i < depth && mixed.length < limit; i += 1) {
    for (const row of rows) {
      if (mixed.length >= limit) break;
      const song = row[i];
      if (!song || seen.has(song.videoId)) continue;
      seen.add(song.videoId);
      mixed.push(song);
    }
  }
  return mixed;
}

/**
 * Drops tracks the user has already played. Recommendations that hand back what
 * someone just listened to read as broken, and the library rows right below
 * already cover "play it again".
 */
export function excludePlayed(songs: MusicSongResult[], playedItemIds: Set<string>): MusicSongResult[] {
  return songs.filter((song) => !song.jellyfinItemId || !playedItemIds.has(song.jellyfinItemId));
}
