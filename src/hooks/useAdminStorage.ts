import { useQuery } from '@tanstack/react-query';
import { getAdminStorage } from '../api/bff';
import { queryKeys } from './queryKeys';

// Admin screen's "Almacenamiento" card - server media-disk usage. Polled so an
// admin watching a big download fill the disk sees it move without a reload.
export function useAdminStorage() {
  return useQuery({
    queryKey: queryKeys.adminStorage(),
    queryFn: getAdminStorage,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
