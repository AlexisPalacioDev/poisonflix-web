import { useQueries, useQuery } from '@tanstack/react-query';
import { getPlayedAudio, getRandomLibraryAudio } from '../api/jellyfin';
import { getRadio, getRecommendations } from '../api/music';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import type { MusicResultItem, MusicSongResult } from '../api/schemas/music';
import {
  buildFeedRows,
  excludePlayed,
  pickSeedTracks,
  songsOnly,
  trackArtist,
  type FeedSource,
} from '../lib/domain/musicTaste';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Música's personalised home feed, modelled on YouTube Music: your listening is
// the input, and it comes back as a mix plus a row per thing you're into.
//
// Three tiers, best signal first, because the fallback matters as much as the
// happy path:
//
//  1. what this user has PLAYED  (Jellyfin UserData, fed by useMusicScrobble)
//  2. what this user OWNS        (a random spread of their own library)
//  3. the worker's generic feed  (seeded from the last download on the SERVER)
//
// Tier 3 is the one to be suspicious of: it is the same for every user and
// reflects whoever downloaded last, so it is a last resort and it is never
// labelled as personal.

const HISTORY_LIMIT = 40;
const LIBRARY_SAMPLE = 30;
const RADIO_PER_SEED = 12;
const MIX_LIMIT = 20;

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

  // Most-played first: what someone returns to describes their taste better
  // than whatever happened to be last, which may well have been a one-off.
  const history = useQuery({
    queryKey: queryKeys.musicHistory(userId, 'PlayCount'),
    queryFn: () => getPlayedAudio(userId, { sortBy: 'PlayCount', limit: HISTORY_LIMIT }),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const historyItems: JellyfinItem[] = history.data?.Items ?? [];
  const playedItemIds = new Set(historyItems.map((item) => item.Id));
  const historySeeds = pickSeedTracks(historyItems);

  // Two ways to reach the cold start: a user who has not played anything yet,
  // or a Jellyfin hiccup on the history call. Both fall through to the library.
  const historySettled = history.isSuccess || history.isError;
  const needsLibrary = historySettled && historySeeds.length === 0;

  const library = useQuery({
    queryKey: queryKeys.musicLibrarySample(userId),
    queryFn: () => getRandomLibraryAudio(userId, LIBRARY_SAMPLE),
    enabled: Boolean(userId) && needsLibrary,
    // The sample is random server-side; refetching would reshuffle the rows
    // under the user mid-session, so it is held for the session's lifetime.
    staleTime: Infinity,
  });

  const librarySeeds = needsLibrary ? pickSeedTracks(library.data?.Items ?? []) : [];
  const source: FeedSource = historySeeds.length > 0 ? 'history' : 'library';
  const seedItems = historySeeds.length > 0 ? historySeeds : librarySeeds;

  const radios = useQueries({
    queries: seedItems.map((seed) => ({
      queryKey: queryKeys.musicSeedRadio(userId, seed.Id),
      queryFn: () => getRadio({ itemId: seed.Id }, RADIO_PER_SEED),
      staleTime: 30 * 60_000,
    })),
  });

  // Last resort: nothing played, nothing in the library. Only here is the
  // server-wide feed shown, and it says so.
  const librarySettled = library.isSuccess || library.isError;
  const needsGeneric = needsLibrary && librarySettled && librarySeeds.length === 0;

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

  const perSeed: MusicSongResult[][] = radios.map((radio) =>
    excludePlayed(songsOnly(radio.data ?? []), playedItemIds),
  );

  const seeds = seedItems.map((item) => ({
    id: item.Id,
    // Naming the row after the artist is what tells the user WHY it exists.
    label: trackArtist(item) ?? item.Name,
  }));

  return {
    rows: buildFeedRows(seeds, perSeed, source, MIX_LIMIT),
    isLoading:
      history.isLoading ||
      (needsLibrary && library.isLoading) ||
      radios.some((radio) => radio.isLoading),
    isGeneric: false,
  };
}
