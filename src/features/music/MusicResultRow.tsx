import type { MusicJobState, MusicSearchResult } from '../../api/schemas/music';
import { isRowActive } from '../../lib/domain/musicTrack';
import type { MusicTrack } from './musicPlayerCore';
import { CoverImage } from './CoverImage';
import { PlayButton } from './PlayButton';
import { MusicRowMenu } from './MusicRowMenu';
import { formatDuration } from './format';

// One search / recommendation result row. Presentational: the parent owns the
// download job state (via `useMusicDownload`) and the player actions, so the
// same row renders in the "Resultados" list and the "Recomendados para ti"
// feed identically. A "de YouTube" badge marks fallback-surface hits.

export interface MusicResultRowProps {
  result: MusicSearchResult;
  state: MusicJobState | undefined;
  itemId: string | null;
  onDownload: (result: MusicSearchResult) => void;
  onPlay: (result: MusicSearchResult, itemId: string) => void;
  onEnqueue: (result: MusicSearchResult, itemId: string) => void;
  /** Queue a not-yet-downloaded hit as a stream. */
  onEnqueuePreview: (result: MusicSearchResult) => void;
  // Instant-play a not-yet-downloaded result by streaming it (no download).
  onPreview: (result: MusicSearchResult) => void;
  /** The player's current track, so the row that is sounding shows ⏸ and its
   *  button pauses instead of restarting what is already playing. */
  current: MusicTrack | null;
  isPlaying: boolean;
  onToggle: () => void;
}

export function MusicResultRow({
  result,
  state,
  itemId,
  onDownload,
  onPlay,
  onEnqueue,
  onEnqueuePreview,
  onPreview,
  current,
  isPlaying,
  onToggle,
}: MusicResultRowProps) {
  // Playable straight from the library when the worker matched this videoId to a
  // downloaded track, OR when we just finished downloading it this session.
  const playItemId =
    result.downloaded && result.jellyfinItemId
      ? result.jellyfinItemId
      : state === 'done' && itemId
        ? itemId
        : null;
  const title = result.title ?? 'Sin título';
  const active = isRowActive(current, { videoId: result.videoId, playItemId });
  const fromYouTube = result.source === 'youtube';

  return (
    <li className="pf-music__row">
      <div className="pf-music__art">
        <CoverImage src={result.thumbnailUrl} loading="lazy" />
      </div>
      <div className="pf-music__info">
        <span className="pf-music__title">
          {title}
          {fromYouTube && <span className="pf-music__badge">de YouTube</span>}
        </span>
        <span className="pf-music__sub">
          {[result.artist, result.album].filter(Boolean).join(' · ') || 'Desconocido'}
        </span>
      </div>
      {result.durationSeconds != null && (
        <span className="pf-music__dur">{formatDuration(result.durationSeconds)}</span>
      )}
      <PlayButton
        active={active}
        isPlaying={isPlaying}
        onClick={() =>
          active ? onToggle() : playItemId ? onPlay(result, playItemId) : onPreview(result)
        }
        label={playItemId ? `Reproducir ${title}` : `Reproducir ${title} sin descargar`}
      />
      <MusicRowMenu
        title={title}
        itemId={playItemId}
        downloadParams={{
          videoId: result.videoId,
          title: result.title ?? undefined,
          artist: result.artist ?? undefined,
          album: result.album ?? undefined,
        }}
        onDownload={() => onDownload(result)}
        onEnqueue={(id) => (id ? onEnqueue(result, id) : onEnqueuePreview(result))}
      />
    </li>
  );
}
