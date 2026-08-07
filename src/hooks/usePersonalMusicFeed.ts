import { useQueries, useQuery } from '@tanstack/react-query';
import { getPlayedAudio, getRandomLibraryAudio } from '../api/jellyfin';
import { getPreviewPlays, getRadio, getRecommendations, type RadioSeed } from '../api/music';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import type { MusicResultItem, MusicSongResult } from '../api/schemas/music';
import {
  buildFeedRows,
  excludePlayed,
  pickPlaySeeds,
  pickSeedTracks,
  songsOnly,
  trackArtist,
  type FeedSeed,
  type FeedSource,
} from '../lib/domain/musicTaste';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Música's personalised home feed, modelled on YouTube Music: your listening is
// the input, and it comes back as a mix plus a row per thing you're into.
//
// Four tiers, best signal first, because the fallback matters as much as the
// happy path:
//
//  1. what this user actually STREAMED (the worker's preview-play tally,
//     `GET /plays` — this is the primary source, because an install with
//     nothing ever downloaded still has this)
//  2. what this user has PLAYED  (Jellyfin UserData, fed by useMusicScrobble —
//     downloaded-and-played, kept as a fallback for installs with a library)
//  3. what this user OWNS        (a random spread of their own library)
//  4. the worker's generic feed  (seeded from the last download on the SERVER)
//
// Tier 4 is the one to be suspicious of: it is the same for every user and
// reflects whoever downloaded last, so it is a last resort and it is never
// labelled as personal.

const HISTORY_LIMIT = 40;
const LIBRARY_SAMPLE = 30;
const RADIO_PER_SEED = 12;
const MIX_LIMIT = 20;

/** Turns a Jellyfin item into a feed seed with an honest label. */
function jellyfinSeed(item: JellyfinItem): FeedSeed {
  return { id: item.Id, label: trackArtist(item) ?? item.Name };
}

export interface MusicFeedRow {
  key: string;
  title: string;
  items: MusicResultItem[];
}

export interface PersonalMusicFeed {
  rows: MusicFeedRow[];
  isLoading: boolean;
  /** True while the rows come from the server-wide feed rather than anything
   * about this user — the state the UI must not dress up as personal. */
  isGeneric: boolean;
}

export function usePersonalMusicFeed(): PersonalMusicFeed {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';

  // Primary signal: what the worker has actually seen this user stream,
  // regardless of whether any of it was ever downloaded. An install with an
  // empty Jellyfin music library (the reported case) still has this, because
  // it comes from YouTube Music previews, not from anything on disk.
  const previewPlays = useQuery({
    queryKey: queryKeys.previewPlays(userId),
    queryFn: getPreviewPlays,
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const previewSeeds = pickPlaySeeds(previewPlays.data ?? []);
  const previewSettled = previewPlays.isSuccess || previewPlays.isError;

  // Fallback for installs that DO have downloaded music: most-played first,
  // since what someone returns to describes their taste better than whatever
  // happened to be last, which may well have been a one-off.
  const history = useQuery({
    queryKey: queryKeys.musicHistory(userId, 'PlayCount'),
    queryFn: () => getPlayedAudio(userId, { sortBy: 'PlayCount', limit: HISTORY_LIMIT }),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const historyItems: JellyfinItem[] = history.data?.Items ?? [];
  const playedItemIds = new Set(historyItems.map((item) => item.Id));
  // Only worth computing once previews are known empty — previews outrank
  // Jellyfin history, so there is nothing to gain from racing ahead here.
  const needsHistorySeeds = previewSettled && previewSeeds.length === 0;
  const historySeeds = needsHistorySeeds ? pickSeedTracks(historyItems).map(jellyfinSeed) : [];

  // Three ways to reach the cold start: no previews yet, no Jellyfin history
  // either, or a Jellyfin hiccup on the history call. All fall through to the
  // library sample.
  const historySettled = history.isSuccess || history.isError;
  const needsLibrary = needsHistorySeeds && historySettled && historySeeds.length === 0;

  const library = useQuery({
    queryKey: queryKeys.musicLibrarySample(userId),
    queryFn: () => getRandomLibraryAudio(userId, LIBRARY_SAMPLE),
    enabled: Boolean(userId) && needsLibrary,
    // The sample is random server-side; refetching would reshuffle the rows
    // under the user mid-session, so it is held for the session's lifetime.
    staleTime: Infinity,
  });

  const librarySeeds = needsLibrary ? pickSeedTracks(library.data?.Items ?? []).map(jellyfinSeed) : [];

  // Preview plays and Jellyfin history are both real listening and both earn
  // the "Porque escuchaste" framing; only the library sample has not actually
  // been played, so it alone gets the honest "based on your library" label.
  const usingPreviewSeeds = previewSeeds.length > 0;
  const usingHistorySeeds = !usingPreviewSeeds && historySeeds.length > 0;
  const source: FeedSource = usingPreviewSeeds || usingHistorySeeds ? 'history' : 'library';
  const seeds: FeedSeed[] = usingPreviewSeeds ? previewSeeds : usingHistorySeeds ? historySeeds : librarySeeds;

  // A preview seed is a raw YouTube videoId; a Jellyfin-sourced seed is a
  // library item id that the worker resolves back to a videoId. Radios seeded
  // one way must never read from the other's cache entry — same string could
  // mean two unrelated tracks — hence the split queryKey helper.
  const radioSeedOf = (seed: FeedSeed): RadioSeed =>
    usingPreviewSeeds ? { videoId: seed.id } : { itemId: seed.id };
  const radioQueryKeyOf = (seed: FeedSeed) =>
    usingPreviewSeeds
      ? queryKeys.musicSeedRadioByVideo(userId, seed.id)
      : queryKeys.musicSeedRadio(userId, seed.id);
  const pureRadioQueryKeyOf = (seed: FeedSeed) =>
    usingPreviewSeeds
      ? queryKeys.musicSeedRadioByVideoPure(userId, seed.id)
      : queryKeys.musicSeedRadioPure(userId, seed.id);

  // The worker's default, fully-personalised radio per seed. This is what
  // "Mix para vos" mixes from — blending in the user's top artists, likes and
  // history alongside the seed is exactly the personalisation that row wants.
  const radios = useQueries({
    queries: seeds.map((seed) => ({
      queryKey: radioQueryKeyOf(seed),
      queryFn: () => getRadio(radioSeedOf(seed), RADIO_PER_SEED),
      staleTime: 30 * 60_000,
    })),
  });

  // A SEPARATE, `pure`-mode radio per seed, fetched only for history-sourced
  // seeds — library seeds never earn a "Porque escuchaste" row (see
  // `buildFeedRows`'s `source === 'library'` branch), so there is nothing for
  // a pure radio to feed there. This is the fix for the reported bug: the
  // worker's three user-global sources (your artists/likes/history) are
  // identical for every seed of the same user, so mixing them into each
  // "Porque escuchaste X" row made every row converge on the same handful of
  // tracks. `pure: true` drops those three and keeps only what the seed
  // itself and its "related" set contribute.
  const pureRadios = useQueries({
    queries:
      source === 'history'
        ? seeds.map((seed) => ({
            queryKey: pureRadioQueryKeyOf(seed),
            queryFn: () => getRadio(radioSeedOf(seed), RADIO_PER_SEED, { pure: true }),
            staleTime: 30 * 60_000,
          }))
        : [],
  });

  const mixPerSeed: MusicSongResult[][] = radios.map((radio) =>
    excludePlayed(songsOnly(radio.data ?? []), playedItemIds),
  );
  const perSeed: MusicSongResult[][] =
    source === 'history'
      ? pureRadios.map((radio) => excludePlayed(songsOnly(radio.data ?? []), playedItemIds))
      : mixPerSeed;

  const rows = buildFeedRows(seeds, perSeed, source, MIX_LIMIT, mixPerSeed);

  // The radios that decide whether the seeded tiers have anything to show:
  // pure radios for history seeds (they gate the per-seed rows), the default
  // ones for library seeds (their only fetch). Checked with `isSuccess ||
  // isError`, never `!isLoading` alone, so this can only flip once every
  // radio has genuinely settled — the same discipline `needsLibrary` already
  // uses below. Without it, a still-loading radio would read as "empty" and
  // flash the generic feed before the real rows arrive.
  const seedGatingRadios = source === 'history' ? pureRadios : radios;
  const seedRadiosSettled =
    seeds.length > 0 &&
    seedGatingRadios.length === seeds.length &&
    seedGatingRadios.every((radio) => radio.isSuccess || radio.isError);
  const mixRadiosSettled = radios.length === 0 || radios.every((radio) => radio.isSuccess || radio.isError);
  // With seeds present, every radio produced nothing usable (empty results,
  // or every one failed outright — a cold worker container, a 502). Left
  // alone this used to reach `rows.length === 0` with no fallback: the whole
  // feed section vanished, no skeleton, no message. See MusicScreen /
  // RecommendationsRow, which render nothing for a row-less, non-loading feed.
  const seedsProducedNothing = seeds.length > 0 && seedRadiosSettled && mixRadiosSettled && rows.length === 0;

  // Last resort: no previews, nothing played, nothing in the library — OR
  // seeds existed but every radio settled empty/failed. Only here is the
  // server-wide feed shown, and it says so.
  const librarySettled = library.isSuccess || library.isError;
  const needsGeneric =
    (needsLibrary && librarySettled && librarySeeds.length === 0) || seedsProducedNothing;

  const generic = useQuery({
    queryKey: queryKeys.musicRecommendations(''),
    queryFn: () => getRecommendations(),
    enabled: Boolean(userId) && needsGeneric,
    staleTime: 5 * 60_000,
  });

  if (needsGeneric) {
    return {
      rows: generic.data?.length
        ? [{ key: 'generic', title: 'Populares en YouTube Music', items: generic.data }]
        : [],
      isLoading: generic.isLoading,
      isGeneric: true,
    };
  }

  return {
    rows,
    isLoading:
      previewPlays.isLoading ||
      history.isLoading ||
      (needsLibrary && library.isLoading) ||
      radios.some((radio) => radio.isLoading) ||
      pureRadios.some((radio) => radio.isLoading),
    isGeneric: false,
  };
}
