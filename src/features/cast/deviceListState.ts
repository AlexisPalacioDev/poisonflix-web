// Which of the five things the device sheet shows.
//
// Extracted from `CastButton`'s JSX and made pure for one reason: as a chain
// of ternaries it was untestable. A mutation that removed the `hasScanned`
// guard left all ten component tests green, because the render it protects is
// the synchronous one before React Query's effect runs — a frame that
// `render()` flushes past and no assertion can ever observe. Here every
// combination is reachable by construction.

export type DeviceListState =
  /** The URLs a television would need cannot be built (dev on localhost). */
  | 'unavailable'
  /** The scan itself failed AND there is nothing cached to keep showing. */
  | 'error'
  /** A scan is running, or has not started yet. */
  | 'scanning'
  /** A scan finished and the network really is empty. */
  | 'empty'
  | 'list';

export interface DeviceListInputs {
  /** Whether `buildCastUrls` produced something castable. */
  urlsReady: boolean;
  deviceCount: number;
  isFetching: boolean;
  /** Whether a scan has ever COMPLETED. Distinct from `isFetching`: the query
   *  starts disabled and only turns on when the sheet opens, so there is a
   *  render with no data and no request in flight. Reading that as "nothing
   *  found" accuses the user's network before anything has been looked at. */
  hasScanned: boolean;
  isError: boolean;
}

export function deviceListState({
  urlsReady,
  deviceCount,
  isFetching,
  hasScanned,
  isError,
}: DeviceListInputs): DeviceListState {
  if (!urlsReady) return 'unavailable';
  // Devices win over an error, deliberately. A background re-scan that fails
  // leaves the previous list in the cache; replacing televisions we KNOW are
  // there with an error banner would be a lie about the network - the same
  // rule the Juegos library already follows for a failed refetch.
  if (deviceCount > 0) return 'list';
  if (isFetching || !hasScanned) return 'scanning';
  if (isError) return 'error';
  return 'empty';
}
