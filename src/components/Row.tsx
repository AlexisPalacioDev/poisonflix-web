import type { ReactNode } from 'react';
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
}

export function Row<T>({ title, items, isLoading, isError, onRetry, renderItem, emptyMessage }: RowProps<T>) {
  return (
    <section className="pf-row" aria-label={title}>
      <h2 className="pf-row__title">{title}</h2>

      {isLoading && <p className="pf-row__status">Cargando…</p>}

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

      {!isLoading && !isError && items && items.length > 0 && (
        <div className="pf-row__track">{items.map((item) => renderItem(item))}</div>
      )}
    </section>
  );
}
