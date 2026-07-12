import { useMutation } from '@tanstack/react-query';
import { requestMedia } from '../api/jellyseerr';
import type { JellyseerrRequestDto } from '../api/schemas/jellyseerr';

// "Pedir" mutation (design.md §2 `useRequestMedia`, tasks.md 6.2), ported
// from `DetailRepositoryImpl.requestMedia` (L120-134, detail-request spec).
// Deliberately a thin wrapper with no `onSuccess`/`onMutate` here: the
// detail-request spec requires the displayed status to come from
// `response.media.status` (not an assumed local value) and to NEVER
// optimistically flip before the server confirms, so the status derivation
// stays in the calling component (`DetailScreen`), not baked into this hook.
export function useRequestMedia() {
  return useMutation<JellyseerrRequestDto, unknown, number>({
    mutationFn: (tmdbId: number) => requestMedia({ mediaType: 'movie', mediaId: tmdbId }),
  });
}
