import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './Row.css';

// Reusable horizontal row primitive (design.md §2 `components/Row.tsx`) -
// row-scoped loading/error/retry state is the piece that makes ADR-3's row
// isolation visible in the UI: a row only ever renders ITS OWN status, never
// a screen-wide one, so one failing row can never blank another (home spec:
// "Row isolation"). Generic over the item shape so Search (Slice 5) can
// reuse it for its results carousel without any change here.
interface RowProps<T> {
  title: string;
  items: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  renderItem: (item: T) => ReactNode;
  emptyMessage: string;
  /** When set, the row title becomes a link to this route (its "ver todo"
   * grid, e.g. `/category/action`) with a trailing chevron affordance. Omitted
   * -> a plain, non-interactive heading (back-compat with rows that have no
   * dedicated full grid). Row stays presentational: it only receives the route
   * string, never any routing/category logic. */
  titleTo?: string;
}

export function Row<T>({ title, items, isLoading, isError, onRetry, renderItem, emptyMessage, titleTo }: RowProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Which edge arrows to show. A vertical-wheel mouse on desktop can't move an
  // `overflow-x` rail at all, so without these controls the rail is unreachable
  // (only trackpad/shift+wheel/scrollbar-drag work). We hide the arrow that
  // points at an already-reached edge so there's never a dead control.
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const hasContent = !isLoading && !isError && items != null && items.length > 0;

  const updateOverflow = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // 1px slack absorbs sub-pixel rounding at the extremes so the arrow
    // reliably disappears exactly at each end.
    const maxScroll = el.scrollWidth - el.clientWidth;
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < maxScroll - 1,
    });
  }, []);

  // Recompute reachability whenever the content changes (items arriving after
  // load) and whenever the rail is resized (viewport/orientation change).
  useEffect(() => {
    const el = trackRef.current;
    if (!el || !hasContent) return;

    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasContent, items, updateOverflow]);

  function scrollByPage(direction: -1 | 1) {
    const el = trackRef.current;
    if (!el) return;
    // Page by ~80% of the visible width so a card or two stays on screen as an
    // anchor between presses (the Netflix/Disney+ rail convention).
    const amount = el.clientWidth * 0.8 * direction;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: amount, behavior: reduce ? 'auto' : 'smooth' });
  }

  return (
    <section className="pf-row" aria-label={title}>
      {titleTo ? (
        <h2 className="pf-row__title">
          <Link className="pf-row__title-link" to={titleTo}>
            <span>{title}</span>
            <span className="pf-row__title-cta" aria-hidden="true">
              Ver todo
              <ChevronIcon direction="right" />
            </span>
          </Link>
        </h2>
      ) : (
        <h2 className="pf-row__title">{title}</h2>
      )}

      {isLoading && (
        <div className="pf-row__track pf-row__track--skeleton" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="pf-skeleton pf-row__skeleton-card" />
          ))}
        </div>
      )}

      {isError && (
        <div className="pf-row__status pf-row__status--error" role="alert">
          <span>No se pudo cargar “{title}”.</span>
          <button type="button" className="pf-row__retry" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}

      {!isLoading && !isError && items && items.length === 0 && (
        <p className="pf-row__status">{emptyMessage}</p>
      )}

      {hasContent && (
        <div className="pf-row__viewport">
          {overflow.left && (
            <button
              type="button"
              className="pf-row__nav pf-row__nav--prev"
              aria-label={`Desplazar “${title}” hacia atrás`}
              onClick={() => scrollByPage(-1)}
            >
              <ChevronIcon direction="left" />
            </button>
          )}

          <div className="pf-row__track" ref={trackRef} onScroll={updateOverflow}>
            {items.map((item) => renderItem(item))}
          </div>

          {overflow.right && (
            <button
              type="button"
              className="pf-row__nav pf-row__nav--next"
              aria-label={`Desplazar “${title}” hacia adelante`}
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
