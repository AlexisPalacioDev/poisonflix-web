import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPlaylistBatch, requestPlaylist, type PlaylistRequest } from '../api/music';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Downloads a whole collection (album `browseId`, playlist `playlistId`, or raw
// URL), then polls the returned batch until every job settles. Each collection
// card owns one instance, so cards track independent batches. Keeps a single
// active batch — a new submit replaces the previous one. When the batch
// completes, the user's Jellyfin Audio library is invalidated so the fresh
// tracks surface without a manual refresh (same trick as `useMusicDownload`).

function isComplete(
  batch: { total?: number; done?: number; failed?: number } | null | undefined,
): boolean {
  if (!batch) return false;
  const total = batch.total ?? 0;
  const done = batch.done ?? 0;
  const failed = batch.failed ?? 0;
  return total > 0 && done + failed >= total;
}

export function usePlaylistDownload() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';
  const [batchId, setBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);

  const submit = useCallback(async (request: PlaylistRequest) => {
    setSubmitError(false);
    setSubmitting(true);
    setBatchId(null);
    try {
      const res = await requestPlaylist(request);
      setBatchId(res.batchId);
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  }, []);

  const statusQuery = useQuery({
    queryKey: queryKeys.musicPlaylistBatch(batchId ?? ''),
    queryFn: () => getPlaylistBatch(batchId as string),
    enabled: Boolean(batchId),
    // Poll until the batch settles, then stop.
    refetchInterval: (query) => (isComplete(query.state.data) ? false : 2000),
  });

  const batch = statusQuery.data ?? null;

  // Surface freshly-downloaded tracks in "Tu música" once the batch completes.
  useEffect(() => {
    if (isComplete(batch ?? undefined) && userId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.musicLibrary(userId) });
    }
    // Only re-run when the completion boolean flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComplete(batch ?? undefined), userId]);

  const reset = useCallback(() => {
    setBatchId(null);
    setSubmitError(false);
  }, []);

  return {
    submit,
    submitting,
    submitError,
    batch,
    complete: isComplete(batch ?? undefined),
    reset,
  };
}
