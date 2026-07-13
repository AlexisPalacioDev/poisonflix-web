import { useEffect, useMemo, useState } from 'react';
import { Header } from '../../components/Header';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { grabRelease } from '../../api/prowlarr';
import { useAdultInfo } from '../../hooks/useAdultInfo';
import { useAdultSearch } from '../../hooks/useAdultRow';
import type { AdultRowItem } from '../../hooks/useAdultRow';
import './adultSearch.css';

// +18 search screen (`/search_adult`, projector-feature-map.md §6/§7's adult
// search mode, walkthrough's `SearchScreen(adult=true)`). Mirrors
// `SearchScreen.tsx`'s two-part layout (debounced results carousel + big
// preview panel) but sources results from Prowlarr/AniList instead of
// Jellyseerr, and its "request" action is a Prowlarr grab instead of a
// Jellyseerr request. Deliberately self-contained: there is no routed +18
// detail screen (no `adult:` id scheme) - the preview is inline here, same
// as `SearchScreen`'s own preview panel.

function toAdultPosterItem(entry: AdultRowItem): PosterItem {
  return {
    id: entry.title,
    title: entry.title,
    imageUrl: entry.posterUrl,
  };
}

export function AdultSearchScreen() {
  const [query, setQuery] = useState('');
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const { debouncedQuery, enabled, isLoading, isError, items, refetch } = useAdultSearch(query);

  const posterItems = useMemo(() => items.map(toAdultPosterItem), [items]);

  // Same "auto-select first result" fallback as `SearchScreen.tsx` - the
  // preview panel is never blank once results exist.
  const selectedEntry =
    (selectedTitle != null ? items.find((entry) => entry.title === selectedTitle) : undefined) ??
    items[0] ??
    null;

  const emptyMessage = enabled
    ? `Sin resultados para "${debouncedQuery}"`
    : 'Escribí al menos 2 caracteres para buscar.';

  return (
    <main className="pf-adult-search">
      <Header />

      <div className="pf-adult-search__query">
        <input
          type="search"
          className="pf-adult-search__input"
          placeholder="Buscar en +18…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar en +18"
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
          <PosterCard key={item.id} item={item} onFocus={() => setSelectedTitle(item.id)} />
        )}
        emptyMessage={emptyMessage}
      />

      <AdultBigPreview entry={selectedEntry} />
    </main>
  );
}

type RequestState = 'idle' | 'pending' | 'done' | 'error';

function AdultBigPreview({ entry }: { entry: AdultRowItem | null }) {
  // Hooks must run unconditionally - `useAdultInfo` no-ops (disabled) on an
  // empty title, same "always call, let `enabled` gate it" shape as
  // `AdultSection`'s `useAdultRow`.
  const info = useAdultInfo(entry?.title ?? '');
  const [requestState, setRequestState] = useState<RequestState>('idle');

  // Reset the per-title request state when the focused title changes, so a
  // "Pedido enviado" (or error) from title A never leaks onto title B's button
  // (mirrors DetailScreen's reset-on-[tmdbId,mediaType] effect).
  const entryKey = entry?.prowlarrGuid ?? entry?.title ?? null;
  useEffect(() => {
    setRequestState('idle');
  }, [entryKey]);

  if (!entry) {
    return (
      <div className="pf-adult-search__preview pf-adult-search__preview--empty">
        <p>Buscá y elegí un título para ver el detalle.</p>
      </div>
    );
  }

  const posterUrl = info.data?.posterUrl ?? entry.posterUrl;
  const canRequest = entry.prowlarrGuid != null && entry.prowlarrIndexerId != null;

  async function handleRequest() {
    if (entry.prowlarrGuid == null || entry.prowlarrIndexerId == null) return;
    setRequestState('pending');
    try {
      await grabRelease(entry.prowlarrGuid, entry.prowlarrIndexerId);
      setRequestState('done');
    } catch {
      setRequestState('error');
    }
  }

  const requestLabel =
    requestState === 'pending' ? 'Pidiendo…' : requestState === 'done' ? 'Pedido enviado' : requestState === 'error' ? 'Reintentar Pedir' : 'Pedir';

  return (
    <div className="pf-adult-search__preview">
      <div className="pf-adult-search__preview-art">
        {posterUrl ? (
          <img src={posterUrl} alt="" />
        ) : (
          <span className="pf-adult-search__preview-placeholder" aria-hidden="true">
            {entry.title.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      <div className="pf-adult-search__preview-info">
        <h2 className="pf-adult-search__preview-title">{info.data?.title ?? entry.title}</h2>

        <div className="pf-adult-search__preview-meta">
          {info.data?.episodes != null && <span>{info.data.episodes} ep.</span>}
          {info.data?.score != null && <span>★ {(info.data.score / 10).toFixed(1)}</span>}
        </div>

        {info.data?.synopsis && <p className="pf-adult-search__preview-overview">{info.data.synopsis}</p>}

        <button
          type="button"
          className="pf-adult-search__request"
          onClick={handleRequest}
          disabled={!canRequest || requestState === 'pending'}
        >
          {requestLabel}
        </button>
      </div>
    </div>
  );
}
