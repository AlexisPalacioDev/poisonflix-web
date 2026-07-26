import { useCallback, useEffect, useRef, useState } from 'react';
import type { MusicResultItem, MusicSearchResult } from '../../api/schemas/music';
import { CoverImage } from './CoverImage';
import { MusicCollectionCard } from './MusicCollectionCard';

// "Recomendados para ti" — a Spotify-style horizontal rail of cover cards. Each
// card is playable (once downloaded) or downloadable in place: the circular
// button on the artwork mirrors the same per-videoId job state the search list
// uses, so downloading here surfaces the track everywhere. The rail scrolls
// horizontally; each card's controls are native <button>s for D-pad reach.
//
// Desktop can't move an `overflow-x` rail with a vertical-wheel mouse, so the
// rail carries the same prev/next scroll arrows as the main content carousel
// (components/Row.tsx): native <button>s shown on hover/focus, each hidden when
// its edge is already reached, hidden entirely on touch (@media hover:none).

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface RecommendationsRowProps {
  items: MusicResultItem[];
  isLoading: boolean;
  onPlay: (result: MusicSearchResult, itemId: string) => void;
  onPreview: (result: MusicSearchResult) => void;
}

export function RecommendationsRow({
  items,
  isLoading,
  onPlay,
  onPreview,
}: RecommendationsRowProps) {
  const railRef = useRef<HTMLDivElement>(null);
  // Which edge arrows to show. Hide the arrow pointing at an already-reached
  // edge so there's never a dead control (mirrors components/Row.tsx).
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const hasContent = !isLoading && items.length > 0;

  const updateOverflow = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    // 1px slack absorbs sub-pixel rounding so an arrow disappears exactly at
    // each end.
    const maxScroll = el.scrollWidth - el.clientWidth;
    setOverflow({ left: el.scrollLeft > 1, right: el.scrollLeft < maxScroll - 1 });
  }, []);

  // Recompute reachability when the content arrives and when the rail resizes.
  useEffect(() => {
    const el = railRef.current;
    if (!el || !hasContent) return;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasContent, items, updateOverflow]);

  const scrollByPage = useCallback((direction: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    // Page by ~80% of the visible width so a card or two stays on screen as an
    // anchor between presses (same convention as the main carousel).
    const amount = el.clientWidth * 0.8 * direction;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: amount, behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  // Nothing to show and nothing coming: render nothing so the landing stays clean.
  if (!isLoading && items.length === 0) return null;

  return (
    <section className="pf-music__section" aria-label="Recomendados para ti">
      <h2 className="pf-music__heading">Recomendados para ti</h2>
      {isLoading ? (
        <div className="pf-music__rail" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="pf-music__rec pf-music__rec--skeleton">
              <div className="pf-music__rec-art pf-skeleton" />
            </div>
          ))}
        </div>
      ) : (
        <div className="pf-music__rail-viewport">
          {overflow.left && (
            <button
              type="button"
              className="pf-music__rail-nav pf-music__rail-nav--prev"
              aria-label="Desplazar recomendados hacia atrás"
              onClick={() => scrollByPage(-1)}
            >
              <ChevronIcon direction="left" />
            </button>
          )}

          <div className="pf-music__rail" ref={railRef} onScroll={updateOverflow}>
            {items.map((result) => {
              if (result.type !== 'song') {
                return (
                  <MusicCollectionCard
                    key={
                      result.type === 'album'
                        ? `album-${result.browseId}`
                        : `playlist-${result.playlistId}`
                    }
                    item={result}
                    layout="rail"
                  />
                );
              }
              // Already in the library (matched by videoId) -> play from Jellyfin;
              // otherwise the same button previews it instantly (streams, no download).
              const playItemId =
                result.downloaded && result.jellyfinItemId ? result.jellyfinItemId : null;
              const title = result.title ?? 'Sin título';
              return (
                <div key={result.videoId} className="pf-music__rec">
                  <div className="pf-music__rec-art">
                    <CoverImage src={result.thumbnailUrl} loading="lazy" />
                    <button
                      type="button"
                      className="pf-music__rec-btn"
                      onClick={() => (playItemId ? onPlay(result, playItemId) : onPreview(result))}
                      aria-label={
                        playItemId ? `Reproducir ${title}` : `Reproducir ${title} sin descargar`
                      }
                    >
                      <PlayGlyph />
                    </button>
                  </div>
                  <span className="pf-music__rec-title">{title}</span>
                  <span className="pf-music__rec-sub">{result.artist ?? 'Desconocido'}</span>
                </div>
              );
            })}
          </div>

          {overflow.right && (
            <button
              type="button"
              className="pf-music__rail-nav pf-music__rail-nav--next"
              aria-label="Desplazar recomendados hacia adelante"
              onClick={() => scrollByPage(1)}
            >
              <ChevronIcon direction="right" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
