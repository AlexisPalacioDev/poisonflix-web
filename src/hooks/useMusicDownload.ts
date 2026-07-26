import { useCallback, useEffect, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { getMusicJob, requestDownload, type RequestDownloadParams } from '../api/music';
import type { MusicJobState } from '../api/schemas/music';
import { queryKeys } from './queryKeys';
import { useAuth } from './useAuth';

// Drives per-result downloads on the Música screen: fires the download, then
// polls the returned job until it settles. Keyed by videoId so each result row
// can reflect its own progress. When a job reaches `done`, the user's Jellyfin
// Audio library is invalidated so the freshly-downloaded track appears in
// "Tu música" without a manual refresh.

interface TrackedJob {
  jobId: string;
  state: MusicJobState;
  // Set once the worker reports the scanned Jellyfin Audio item — lets the
  // Música screen play/enqueue a freshly-downloaded result without waiting for
  // the whole library query to refetch.
  itemId: string | null;
}

const TERMINAL: MusicJobState[] = ['done', 'failed'];

function isTerminal(state: MusicJobState): boolean {
  return TERMINAL.includes(state);
}

export function useMusicDownload() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.jellyfinUserId ?? '';
  const [jobs, setJobs] = useState<Record<string, TrackedJob>>({});

  const download = useCallback(async (params: RequestDownloadParams) => {
    setJobs((prev) => ({
      ...prev,
      // Optimistic "queued" so the button reflects the request immediately.
      [params.videoId]: { jobId: prev[params.videoId]?.jobId ?? '', state: 'queued', itemId: null },
    }));
    try {
      const res = await requestDownload(params);
      setJobs((prev) => ({
        ...prev,
        [params.videoId]: { jobId: res.jobId, state: res.state, itemId: null },
      }));
    } catch {
      setJobs((prev) => ({ ...prev, [params.videoId]: { jobId: '', state: 'failed', itemId: null } }));
    }
  }, []);

  // Poll every non-terminal job that has a real jobId.
  const active = Object.entries(jobs).filter(([, j]) => j.jobId && !isTerminal(j.state));

  const results = useQueries({
    queries: active.map(([, j]) => ({
      queryKey: queryKeys.musicJob(j.jobId),
      queryFn: () => getMusicJob(j.jobId),
      refetchInterval: 1500,
    })),
  });

  useEffect(() => {
    results.forEach((result, index) => {
      const data = result.data;
      const entry = active[index];
      if (!data || !entry) return;
      const [videoId] = entry;
      setJobs((prev) => {
        const current = prev[videoId];
        if (!current) return prev;
        const itemId = data.jellyfinItemId ?? current.itemId;
        if (current.state === data.state && current.itemId === itemId) return prev;
        return { ...prev, [videoId]: { jobId: current.jobId, state: data.state, itemId } };
      });
      if (data.state === 'done' && userId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.musicLibrary(userId) });
      }
    });
    // `active` is derived from `jobs`; depending on the raw query results is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.data?.state).join(','), userId]);

  const stateByVideoId = useCallback(
    (videoId: string): MusicJobState | undefined => jobs[videoId]?.state,
    [jobs],
  );

  // The scanned Jellyfin item id for a completed download, or null until the
  // job settles. Lets a "done" search result be played/enqueued in place.
  const itemByVideoId = useCallback(
    (videoId: string): string | null => jobs[videoId]?.itemId ?? null,
    [jobs],
  );

  return { download, stateByVideoId, itemByVideoId };
}
