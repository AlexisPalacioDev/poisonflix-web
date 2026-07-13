import { useMutation } from '@tanstack/react-query';
import { cancelDownload } from '../api/bff';

// Cancel-download flow (Downloads screen, projector-feature-map.md §9 "Cancel
// flow"). Security hardening moved the entire orchestration (radarr/sonarr
// queue delete + unmonitor + Jellyseerr request delete) server-side into a
// single BFF endpoint - the browser no longer resolves Radarr/Sonarr identity
// or talks to those backends directly for this flow. The BFF authorizes the
// call as owner-or-admin against the caller's Jellyseerr session, so this
// hook is now just a thin `useMutation` wrapper over one POST.

export interface CancelDownloadParams {
  /** May be null on a request whose media record carries no TMDB id - the
   * BFF still deletes the Jellyseerr request even when it can't resolve a
   * Radarr/Sonarr identity to clean up. */
  tmdbId: number | null;
  requestId: number;
}

export function useCancelDownload() {
  return useMutation({
    mutationFn: ({ tmdbId, requestId }: CancelDownloadParams) => cancelDownload(requestId, tmdbId),
  });
}
