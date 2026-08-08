import { useEffect, useRef } from 'react';
import { TrackMenuScaffold } from './TrackMenu';
import { jellyfinPosterUrl } from '../../lib/domain/posterUrl';
import type { EpisodeNavItem } from './episodeNavigation';

// Episode jump menu (owner request: navigate between a series' chapters from
// the player). Reuses `TrackMenuScaffold` verbatim - same OverlayShell
// "dialog" pattern as Audio/Subtitle, not a third reimplementation of it.
//
// It does NOT reuse `TrackOptionButton`: episodes carry a still frame, and a
// row here is a thumbnail plus two lines of text rather than the single
// centered label a track option is. It keeps `pf-track-menu__option` as its
// base class so spacing, hover and focus stay identical to the sibling menus,
// and only adds what a thumbnail row needs.

export interface EpisodeMenuProps {
  episodes: EpisodeNavItem[];
  currentEpisodeId: string;
  onSelect: (episodeId: string) => void;
  onDismiss: () => void;
  /** Jellyfin token - thumbnails go through `api_key` because an `<img>`
   *  cannot send an `X-Emby-Token` header (see `jellyfinPosterUrl`). */
  token: string | null;
  /** Portal target - see `AudioTrackMenuProps.container` in TrackMenu.tsx. */
  container?: Element | null;
}

// 320px wide: roughly 2x the ~150px the thumbnail is rendered at, so it stays
// sharp on high-DPI screens without pulling a full-size still for every row.
const THUMBNAIL_MAX_WIDTH = 320;

export function EpisodeMenu({
  episodes,
  currentEpisodeId,
  onSelect,
  onDismiss,
  token,
  container,
}: EpisodeMenuProps) {
  const currentRef = useRef<HTMLButtonElement>(null);

  // Open the menu where the viewer actually is. A series runs to dozens of
  // episodes, so a list that always opens at S01E01 makes someone on S02E02
  // scroll two thirds of the way down just to find their place - the menu
  // would be answering "what episodes exist" when the question is "where am
  // I, and what is next". `block: 'center'` rather than the default 'start'
  // so the neighbouring episodes stay visible, which is the whole point.
  //
  // Guarded on `scrollIntoView` existing: jsdom does not implement it, and an
  // unguarded call would fail every test that renders this menu.
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'center' });
  }, []);

  return (
    <TrackMenuScaffold title="Episodios" onDismiss={onDismiss} container={container}>
      {episodes.map((episode) => {
        const isSelected = episode.id === currentEpisodeId;
        const thumbnailUrl = jellyfinPosterUrl(
          { Id: episode.id, ImageTags: episode.imageTag ? { Primary: episode.imageTag } : null },
          token,
          THUMBNAIL_MAX_WIDTH,
        );

        return (
          <button
            key={episode.id}
            ref={isSelected ? currentRef : undefined}
            type="button"
            className={`pf-track-menu__option pf-episode-option${isSelected ? ' pf-track-menu__option--selected' : ''}`}
            onClick={() => onSelect(episode.id)}
            aria-pressed={isSelected}
          >
            {thumbnailUrl ? (
              <img
                className="pf-episode-option__thumb"
                src={thumbnailUrl}
                alt=""
                loading="lazy"
                decoding="async"
              />
            ) : (
              // Keeps the text column aligned across rows when one episode is
              // missing artwork, instead of letting that row jump left.
              <span className="pf-episode-option__thumb pf-episode-option__thumb--empty" aria-hidden="true" />
            )}
            <span className="pf-episode-option__text">
              <span className="pf-episode-option__number">
                T{episode.seasonNumber} E{episode.episodeNumber}
              </span>
              <span className="pf-episode-option__title">{episode.title}</span>
            </span>
            {isSelected ? (
              <span className="pf-track-menu__check" aria-hidden="true">
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </TrackMenuScaffold>
  );
}
