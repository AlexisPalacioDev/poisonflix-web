import { useQuery } from '@tanstack/react-query';
import { getResumeItems } from '../api/jellyfin';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Home's "Continuar viendo" row source (projector-feature-map.md §3 row 1,
// walkthrough §2). Polls the Jellyfin resume feed every 20s while Home is
// mounted, mirroring HomeViewModel.kt's cadence (native reference polls only
// while Home is resumed via `LifecycleResumeEffect`; react-query's own
// window-focus/mount lifecycle covers that here without extra wiring).
const RESUME_ROW_PARAMS = { limit: 20 } as const;

export function useResumeRow() {
  const { session } = useAuth();
  const userId = session?.jellyfinUserId;

  return useQuery({
    queryKey: queryKeys.resumeRow(userId ?? ''),
    queryFn: () => getResumeItems(userId as string, RESUME_ROW_PARAMS),
    // Gated on a hydrated session like useLibraryRow - never fires before login.
    enabled: Boolean(userId),
    refetchInterval: 20_000,
  });
}
