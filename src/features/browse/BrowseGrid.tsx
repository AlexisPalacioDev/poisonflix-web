import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../../components/Header';
import './browse.css';

// Presentational "ver todo" grid - the full-screen counterpart to the
// horizontal `Row` primitive. A Home row's title links here (Row's `titleTo`)
// and this renders the SAME items in a wrapping vertical grid instead of a
// rail. Kept presentational exactly like Row: it owns its own
// loading/error/retry/empty state (row-isolation, applied per screen) but
// knows nothing about which data source or category it's showing - each thin
// screen wrapper feeds it already-mapped `PosterItem`s.
interface BrowseGridProps<T> {
  title: string;
  items: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  renderItem: (item: T) => ReactNode;
  emptyMessage: string;
}

export function BrowseGrid<T>({
  title,
  items,
  isLoading,
  isError,
  onRetry,
  renderItem,
  emptyMessage,
}: BrowseGridProps<T>) {
  const navigate = useNavigate();
  const hasContent = !isLoading && !isError && items != null && items.length > 0;
  const isEmpty = !isLoading && !isError && items != null && items.length === 0;

  return (
    <main className="pf-browse">
      <Header />

      <div className="pf-browse__header">
        <button
          type="button"
          className="pf-browse__back"
          onClick={() => navigate(-1)}
          aria-label="Volver"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false">
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1 className="pf-browse__title">{title}</h1>
      </div>

      {isLoading && (
        <div className="pf-browse__grid" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="pf-skeleton pf-browse__skeleton-card" />
          ))}
        </div>
      )}

      {isError && (
        <div className="pf-browse__status pf-browse__status--error" role="alert">
          <span>No se pudo cargar “{title}”.</span>
          <button type="button" className="pf-browse__retry" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}

      {isEmpty && <p className="pf-browse__status">{emptyMessage}</p>}

      {hasContent && <div className="pf-browse__grid">{items.map((item) => renderItem(item))}</div>}
    </main>
  );
}
