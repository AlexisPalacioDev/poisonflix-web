import { useQuery } from '@tanstack/react-query';
import { getAnilistInfo } from '../api/anilist';
import { queryKeys } from './queryKeys';
import { useAdultUnlocked } from './useAdultUnlocked';

// AniList metadata (synopsis/poster/banner/episodes/score/genres) for a
// single +18 title, keyed by its (already-cleaned) show title - there is no
// numeric id for adult content, Prowlarr and AniList are both title-keyed.
// Backs the adult search screen's big-preview panel (`getAdultInfo` in
// `MediaRepositoryImpl.kt`).
export function useAdultInfo(title: string) {
  const unlocked = useAdultUnlocked();
  const trimmed = title.trim();

  return useQuery({
    queryKey: queryKeys.adultInfo(trimmed),
    queryFn: () => getAnilistInfo(trimmed),
    enabled: unlocked && trimmed.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}
