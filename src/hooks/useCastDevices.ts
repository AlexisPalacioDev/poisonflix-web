import { useQuery } from '@tanstack/react-query';
import { fetchCastDevices } from '../api/cast';
import type { CastDevice } from '../api/schemas/cast';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// The televisions on the LAN, scanned on demand.
//
// `enabled` is a real parameter rather than an internal `true`: a scan is an
// SSDP/mDNS sweep that takes seconds and floods the network with multicast,
// so it must run when the user opens the cast menu and at no other moment.
// Every player screen mount firing one would be a cost nobody asked for.

// A stable empty array, so `devices` keeps its identity between renders while
// the query is loading or has nothing (same reason as `useGamesLibrary`).
const NO_DEVICES: CastDevice[] = [];

export function useCastDevices(enabled: boolean) {
  const { session } = useAuth();

  const query = useQuery({
    queryKey: queryKeys.castDevices(),
    queryFn: fetchCastDevices,
    enabled: enabled && Boolean(session),
    // A device that just got unplugged should disappear on the next open, but
    // re-opening the menu twice in a row should not re-scan the whole network.
    staleTime: 10_000,
    // No retries: the BFF already answers `{ devices: [] }` with HTTP 200 when
    // the bridge is absent or silent, so an error reaching here is a genuine
    // failure worth showing at once instead of after three slow attempts.
    retry: false,
  });

  return {
    devices: query.data ?? NO_DEVICES,
    isLoading: query.isLoading,
    /** True during a re-scan too, not only the first one — the menu shows
     *  "Buscando…" for both, since a refresh looks identical to the user. */
    isFetching: query.isFetching,
    /** Whether a scan has actually completed. Needed to tell "nothing found"
     *  apart from "not asked yet": the query starts disabled and only turns on
     *  when the menu opens, so for one render there is no data AND no fetch in
     *  flight — long enough to flash "no encontramos nada" at a user whose
     *  network has not been looked at yet. */
    hasScanned: query.isFetched,
    isError: query.isError,
    refetch: query.refetch,
  };
}
