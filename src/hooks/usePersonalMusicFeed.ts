import { useQueries, useQuery } from '@tanstack/react-query';
import { getPlayedAudio } from '../api/jellyfin';
import { getRadio, getRecommendations } from '../api/music';
import type { JellyfinItem } from '../api/schemas/jellyfin';
import type { MusicResultItem, MusicSongResult } from '../api/schemas/music';
import {
  excludePlayed,
  interleave,
  pickSeedTracks,
  songsOnly,
  trackArtist,
} from '../lib/domain/musicTaste';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Música's personalised home feed. Modelled on YouTube Music: your history is
// the input, and it comes back as a mix plus a row per thing you've been into.
//
// The history is Jellyfin's own per-user UserData (see `getPlayedAudio`), fed by
// `useMusicScrobble`. Nothing here is global: two accounts on the same server
// get different rows from the same server, and a user with no history yet falls
// back to the generic feed instead of an empty screen.

const HISTORY_LIMIT = 40;
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
  /** True while the user has no listening history and is seeing the generic
   * feed — the cold start every new account begins in. */
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
  const seeds = pickSeedTracks(historyItems);
  const playedItemIds = new Set(historyItems.map((item) => item.Id));

  const radios = useQueries({
    queries: seeds.map((seed) => ({
      queryKey: queryKeys.musicSeedRadio(userId, seed.Id),
      queryFn: () => getRadio({ itemId: seed.Id }, RADIO_PER_SEED),
      staleTime: 30 * 60_000,
    })),
  });

  // Two ways to end up with nothing to personalise from: a new account with no
  // history yet, or a Jellyfin hiccup on the history call. Both fall back to the
  // generic worker feed — a home screen that stays blank because a side query
  // failed is worse than one that's briefly impersonal.
  const historySettled = history.isSuccess || history.isError;
  const generic = useQuery({
    queryKey: queryKeys.musicRecommendations(''),
    queryFn: () => getRecommendations(),
    enabled: Boolean(userId) && historySettled && seeds.length === 0,
    staleTime: 5 * 60_000,
  });

  if (historySettled && seeds.length === 0) {
    return {
      rows: generic.data?.length
        ? [{ key: 'generic', title: 'Recomendados para ti', items: generic.data }]
        : [],
      isLoading: generic.isLoading,
      isGeneric: true,
    };
  }

  const perSeed: MusicSongResult[][] = radios.map((radio) =>
    excludePlayed(songsOnly(radio.data ?? []), playedItemIds),
  );

  const rows: MusicFeedRow[] = [];
  const mix = interleave(perSeed, MIX_LIMIT);
  if (mix.length > 0) {
    rows.push({ key: 'mix', title: 'Mix para vos', items: mix });
  }
  seeds.forEach((seed, index) => {
    const items = perSeed[index] ?? [];
    if (items.length === 0) return;
    // Name the row after the artist when we know it — "Porque escuchaste
    // Brutalismus 3000" tells the user *why* this row exists, which is what
    // makes a recommendation feel earned instead of arbitrary.
    const label = trackArtist(seed) ?? seed.Name;
    rows.push({ key: `seed-${seed.Id}`, title: `Porque escuchaste ${label}`, items });
  });

  return {
    rows,
    isLoading: history.isLoading || radios.some((radio) => radio.isLoading),
    isGeneric: false,
  };
}
