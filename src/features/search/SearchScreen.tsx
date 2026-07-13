import { useMemo, useState } from 'react';
import { Header } from '../../components/Header';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { StatusBadge, type StatusBadgeVariant } from '../../components/StatusBadge';
import { jellyseerrStatusLabel, type TitleStatus } from '../../lib/domain/libraryIndex';
import { tmdbPosterUrl } from '../../lib/domain/posterUrl';
import { resultTitle, resultYear, useSearch, type SearchResultEntry } from '../../hooks/useSearch';
import { useTitleDetail, type MediaType } from '../../hooks/useTitleDetail';
import { useLibraryItem } from '../../hooks/useLibraryItem';
import { audioLanguagesOf } from '../detail/audioLanguages';
import './search.css';

// Search screen (design.md §7 `/search`, search spec), ported from
// `SearchViewModel.kt` + `SearchScreen.kt`'s two-part layout: a debounced
// results carousel (reusing Home's `Row`/`PosterCard`) on top, and a big
// preview panel for the highlighted result below. The real on-screen
// keyboard from the native app is intentionally NOT built here - the browser
// already has a real keyboard (design.md §8), so the query field is a plain
// focused `<input>`.
//
// Big-preview enrichment (feature-map §5 "Richer search UX", last piece of
// that section - the on-screen `PoisonKeyboard` itself stays a deliberate
// non-port): the preview also fetches the SELECTED result's full per-item
// detail via `useTitleDetail` (same hook Detail uses) to show the richer
// overview + the "Audio disponible" line, reusing `audioLanguagesOf` +
// `useLibraryItem` exactly like DetailScreen does.

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
    // Carry movie/tv so the detail route can fetch the right endpoint.
    mediaType: entry.result.mediaType === 'tv' ? 'tv' : 'movie',
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
  //
  // Empty-results decision (walkthrough §21): the native app has a bug/
  // inconsistency where the preview keeps showing the last/recommended title
  // even when the carousel has zero matches. `entries` being empty already
  // makes both the `find` and the `entries[0]` fallback resolve to
  // `undefined` here, so `selectedEntry` naturally becomes `null` and
  // `BigPreview` renders its empty state instead - the web deliberately picks
  // "clear on empty results" as the cleaner behavior, not a bug to replicate.
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
  // Fetch the SELECTED result's full detail only (feature-map §5) - never
  // the whole carousel - reusing `useTitleDetail`'s shared `queryKeys.detail`
  // cache, so re-selecting a previously-viewed result is served from cache
  // instead of refetching. Hooks must run unconditionally (rules of hooks),
  // so with no selection this just calls the hook with an empty id: inside
  // `useTitleDetail`, `Number('')` is not finite, so `validId` is false and
  // the query stays disabled - no request fires while nothing is selected.
  // Typing doesn't cause extra fetches either: `entries` (and therefore
  // `selectedEntry`) only changes once the debounced query settles, not on
  // every keystroke.
  const mediaType: MediaType = entry ? (entry.result.mediaType === 'tv' ? 'tv' : 'movie') : 'movie';
  const tmdbId = entry ? String(entry.result.id) : '';
  const { detail } = useTitleDetail(tmdbId, mediaType);

  // "Audio disponible" line (DetailScreen parity): movie-only, since a
  // Jellyfin Series item carries no MediaStreams of its own (only its
  // episodes do). Uses the search entry's own `status` - already resolved
  // against the same LibraryIndex/library query `useSearch` and DetailScreen
  // share - instead of waiting on the (independent) detail fetch to settle.
  const libraryItemId =
    entry && mediaType === 'movie' && entry.status.kind === 'InLibrary' ? entry.status.jellyfinItemId : null;
  const { item: libraryItem } = useLibraryItem(libraryItemId);
  const audioLanguages = useMemo(() => audioLanguagesOf(libraryItem), [libraryItem]);

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
  // Richer overview from the fetched full detail, falling back to the search
  // result's own (list-shaped) overview while the detail fetch is in flight
  // or unavailable, so the preview never regresses to blank.
  const overview = detail?.overview ?? result.overview ?? null;

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

        {overview && <p className="pf-search__preview-overview">{overview}</p>}

        {audioLanguages.length > 0 && (
          <p className="pf-search__preview-audio" role="status">
            Audio disponible: {audioLanguages.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
