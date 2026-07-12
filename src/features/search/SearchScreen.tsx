import { useMemo, useState } from 'react';
import { Header } from '../../components/Header';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { StatusBadge, type StatusBadgeVariant } from '../../components/StatusBadge';
import { jellyseerrStatusLabel, type TitleStatus } from '../../lib/domain/libraryIndex';
import { tmdbPosterUrl } from '../../lib/domain/posterUrl';
import { resultTitle, resultYear, useSearch, type SearchResultEntry } from '../../hooks/useSearch';
import './search.css';

// Search screen (design.md §7 `/search`, search spec), ported from
// `SearchViewModel.kt` + `SearchScreen.kt`'s two-part layout: a debounced
// results carousel (reusing Home's `Row`/`PosterCard`) on top, and a big
// preview panel for the highlighted result below. The real on-screen
// keyboard from the native app is intentionally NOT built here - the browser
// already has a real keyboard (design.md §8), so the query field is a plain
// focused `<input>`.

function badgeProps(status: TitleStatus): { variant: StatusBadgeVariant; label: string } {
  switch (status.kind) {
    case 'InLibrary':
      return { variant: 'in-library', label: 'En biblioteca' };
    case 'Requesting':
      return { variant: 'requesting', label: jellyseerrStatusLabel(status.jellyseerrStatus) };
    case 'Requestable':
      return { variant: 'requestable', label: 'Pedir' };
  }
}

function toPosterItem(entry: SearchResultEntry): PosterItem {
  const { variant, label } = badgeProps(entry.status);
  return {
    // Detail's route param is the TMDB id (design.md §7).
    id: String(entry.result.id),
    title: resultTitle(entry.result),
    imageUrl: tmdbPosterUrl(entry.result.posterPath),
    badge: <StatusBadge variant={variant} label={label} />,
  };
}

export function SearchScreen() {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { debouncedQuery, enabled, isLoading, isError, entries, refetch } = useSearch(query);

  const posterItems = useMemo(() => entries.map(toPosterItem), [entries]);

  // Mirrors `SearchViewModel.kt`'s "auto-select first result" (L102/L130):
  // whenever the selection is stale (new search settled, or nothing picked
  // yet), fall back to the first entry so the preview panel is never blank
  // once results exist - purely derived, no effect needed.
  const selectedEntry =
    (selectedId != null ? entries.find((entry) => String(entry.result.id) === selectedId) : undefined) ??
    entries[0] ??
    null;

  const emptyMessage = enabled
    ? `Sin resultados para "${debouncedQuery}"`
    : 'Escribí al menos 2 caracteres para buscar.';

  return (
    <main className="pf-search">
      <Header />

      <div className="pf-search__query">
        <input
          type="search"
          className="pf-search__input"
          placeholder="Buscar películas y series…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar"
          autoFocus
        />
      </div>

      <Row
        title={enabled ? 'Resultados' : 'Buscar'}
        items={posterItems}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        renderItem={(item) => (
          <PosterCard key={item.id} item={item} onFocus={() => setSelectedId(item.id)} />
        )}
        emptyMessage={emptyMessage}
      />

      <BigPreview entry={selectedEntry} />
    </main>
  );
}

function BigPreview({ entry }: { entry: SearchResultEntry | null }) {
  if (!entry) {
    return (
      <div className="pf-search__preview pf-search__preview--empty">
        <p>Buscá y elegí un título para ver el detalle.</p>
      </div>
    );
  }

  const { result, status } = entry;
  const title = resultTitle(result);
  const year = resultYear(result);
  const posterUrl = tmdbPosterUrl(result.posterPath, 'w500');
  const { variant, label } = badgeProps(status);

  return (
    <div className="pf-search__preview">
      <div className="pf-search__preview-art">
        {posterUrl ? (
          <img src={posterUrl} alt="" />
        ) : (
          <span className="pf-search__preview-placeholder" aria-hidden="true">
            {title.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      <div className="pf-search__preview-info">
        <h2 className="pf-search__preview-title">{title}</h2>

        <div className="pf-search__preview-meta">
          {year != null && <span>{year}</span>}
          {result.voteAverage != null && <span>★ {result.voteAverage.toFixed(1)}</span>}
          <StatusBadge variant={variant} label={label} />
        </div>

        {result.overview && <p className="pf-search__preview-overview">{result.overview}</p>}
      </div>
    </div>
  );
}
