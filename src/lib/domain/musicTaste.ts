import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { MusicPlay, MusicResultItem, MusicSongResult } from '../../api/schemas/music';

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

/**
 * Turns the worker's streaming-preview tally (`GET /plays`) into feed seeds.
 *
 * This is the PRIMARY seed source: an install with an empty Jellyfin music
 * library (nothing ever downloaded) still has this, because it comes from
 * previews streamed straight from YouTube Music, not from anything on disk.
 * `pickSeedTracks` stays as the Jellyfin-history/library fallback for
 * installs that do have a populated library — this is a sibling, not a
 * replacement, since the two operate on different shapes (`MusicPlay` has no
 * `Id`/`Artists`, so `pickSeedTracks` cannot be reused directly).
 *
 * Same "one per artist" rule as `pickSeedTracks`, for the same reason: the
 * reported bug was every row echoing the same handful of tracks, and
 * `MAX_SEEDS` seeds off one artist reproduce that just as surely as one seed
 * reused `MAX_SEEDS` times.
 *
 * A play with neither a usable artist nor title cannot be named honestly —
 * "Porque escuchaste " or a raw videoId as the row title is worse than
 * skipping the row, so that play is dropped rather than falling back to id.
 */
export function pickPlaySeeds(plays: MusicPlay[], max = MAX_SEEDS): FeedSeed[] {
  const seeds: FeedSeed[] = [];
  const seenArtists = new Set<string>();
  for (const play of plays) {
    if (seeds.length >= max) break;
    const artist = play.artist.trim() || null;
    const title = play.title.trim() || null;
    const label = artist ?? title;
    if (!label) continue;
    const key = artist?.toLowerCase() ?? `__unknown-${play.videoId}`;
    if (seenArtists.has(key)) continue;
    seenArtists.add(key);
    seeds.push({ id: play.videoId, label });
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
  fillRoundRobin(rows, limit, mixed, new Set<string>());
  return mixed;
}

/** One round-robin sweep, appending to `mixed` and marking what it took.
 *
 * `skip` holds videoIds this sweep must pass over — they stay eligible for a
 * later sweep, because being skipped is a preference, not a ban. */
function fillRoundRobin(
  rows: MusicSongResult[][],
  limit: number,
  mixed: MusicSongResult[],
  seen: Set<string>,
  skip?: ReadonlySet<string>,
): void {
  const depth = Math.max(0, ...rows.map((row) => row.length));
  for (let i = 0; i < depth && mixed.length < limit; i += 1) {
    for (const row of rows) {
      if (mixed.length >= limit) break;
      const song = row[i];
      if (!song || seen.has(song.videoId)) continue;
      if (skip?.has(song.videoId)) continue;
      seen.add(song.videoId);
      mixed.push(song);
    }
  }
}

/**
 * The mix, ordered so it does not open by echoing the rows underneath it.
 *
 * Measured on the running app: the mix shared 5-6 of 12 tracks with each
 * "Porque escuchaste X" row, and its first card was the same track as the
 * first card of the row directly below. The per-seed rows are built from the
 * worker's `pure` radios and the mix from the fully-personalised ones, and the
 * latter is a superset of the former by construction — so drawing both from
 * the top of the same seed guarantees the echo.
 *
 * Two sweeps rather than a filter: the first takes only what no seed row is
 * showing, the second fills whatever is left over from everything. The mix is
 * genuinely a blend of these radios, so it may repeat them — a hard exclusion
 * would have left it with four tracks out of twenty in the measured case. It
 * just may not LEAD with the repeat while fresher tracks wait behind it.
 */
function interleavePreferringUnshown(
  rows: MusicSongResult[][],
  limit: number,
  alreadyShown: ReadonlySet<string>,
): MusicSongResult[] {
  const mixed: MusicSongResult[] = [];
  const seen = new Set<string>();
  fillRoundRobin(rows, limit, mixed, seen, alreadyShown);
  fillRoundRobin(rows, limit, mixed, seen);
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

export interface FeedRow {
  key: string;
  title: string;
  items: MusicSongResult[];
}

/** Where a feed's seeds came from, which decides what it may honestly claim. */
export type FeedSource = 'history' | 'library';

export interface FeedSeed {
  id: string;
  /** Artist when known, else the track title. */
  label: string;
}

/**
 * Lays out the feed rows for a set of seeds and their radios.
 *
 * The `source` is not cosmetic. A history seed earns "Porque escuchaste X" —
 * the user did listen to X, and saying so is what makes the row feel earned.
 * A library seed has not been listened to at all, so claiming otherwise would
 * be a lie; those collapse into a single honestly-named mix instead.
 *
 * `perSeed` and `mixPerSeed` are deliberately separate (mobile-music-overhaul
 * fix-seeded-rows). Each "Porque escuchaste X" row is built from `perSeed`,
 * which the caller is expected to have fetched in the worker's `pure` mode —
 * seed-dependent sources only, so two different seeds never share the three
 * sources (your artists/likes/history) that are identical for every seed of
 * the same user. "Mix para vos" is the opposite: it is SUPPOSED to blend in
 * everything, so it is built from `mixPerSeed`, the worker's normal, fully
 * personalised radios. `mixPerSeed` defaults to `perSeed` for callers that
 * only have one data set (the library-sample fallback has no "pure" concept
 * worth the extra round trip, since library seeds don't get per-seed rows at
 * all — see the `source === 'library'` branch below).
 */
export function buildFeedRows(
  seeds: FeedSeed[],
  perSeed: MusicSongResult[][],
  source: FeedSource,
  mixLimit: number,
  mixPerSeed: MusicSongResult[][] = perSeed,
): FeedRow[] {
  if (source === 'library') {
    const libraryMix = interleave(mixPerSeed, mixLimit);
    if (libraryMix.length === 0) return [];
    return [{ key: 'library-mix', title: 'Basado en tu biblioteca', items: libraryMix }];
  }

  // The seed rows are laid out FIRST so the mix knows what they already show
  // and can lead with something else. They still render below it.
  //
  // Two seeds occasionally come back with the exact same radio (a shared
  // upstream fallback, or two artists whose "related" set collapses to one
  // list) — this is the mechanism behind the reported "same five songs in
  // every row" bug, so an identical tracklist is shown once, not twice. A
  // tracklist dropped here is not counted as shown: nobody sees it.
  const seedRows: FeedRow[] = [];
  const seenTracklists = new Set<string>();
  const shownInSeedRows = new Set<string>();
  seeds.forEach((seed, index) => {
    const items = perSeed[index] ?? [];
    if (items.length === 0) return;
    const tracklist = items.map((item) => item.videoId).join('|');
    if (seenTracklists.has(tracklist)) return;
    seenTracklists.add(tracklist);
    items.forEach((item) => shownInSeedRows.add(item.videoId));
    seedRows.push({
      key: `seed-${seed.id}`,
      title: `Porque escuchaste ${seed.label}`,
      items,
    });
  });

  const mix = interleavePreferringUnshown(mixPerSeed, mixLimit, shownInSeedRows);
  if (mix.length === 0) return [];

  return [{ key: 'mix', title: 'Mix para vos', items: mix }, ...seedRows];
}
