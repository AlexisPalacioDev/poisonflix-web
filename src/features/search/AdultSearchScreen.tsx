import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdultPinOverlay } from '../../components/AdultPinOverlay';
import { Header } from '../../components/Header';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { grabRelease } from '../../api/prowlarr';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { useAdultInfo } from '../../hooks/useAdultInfo';
import { useAdultLibraryItems } from '../../hooks/useAdultLibrary';
import { useAdultRow, useAdultSearch } from '../../hooks/useAdultRow';
import type { AdultRowItem } from '../../hooks/useAdultRow';
import { useAdultUnlocked } from '../../hooks/useAdultUnlocked';
import { useAuth } from '../../hooks/useAuth';
import { isAdultUnlocked } from '../../lib/domain/adultSettings';
import { displayTitle } from '../../lib/domain/displayTitle';
import { jellyfinPosterUrl } from '../../lib/domain/posterUrl';
import './adultSearch.css';

// Dedicated +18 screen (`/search_adult`, projector-feature-map.md §6/§7's adult
// search mode, walkthrough's `SearchScreen(adult=true)`). Reached only through
// the Header's PIN-gated +18 button. Mirrors `SearchScreen.tsx`'s two-part
// layout (results/browse carousel + big preview panel) but sources results
// from Prowlarr/AniList instead of Jellyseerr, and its "request" action is a
// Prowlarr grab instead of a Jellyseerr request. Deliberately self-contained:
// there is no routed +18 detail screen (no `adult:` id scheme) - the preview
// is inline here, same as `SearchScreen`'s own preview panel.
//
// The whole screen is PIN-gated: on a direct visit or a page reload (the
// unlock flag is in-memory only, see `lib/domain/adultSettings.ts`) it renders
// the PIN overlay and shows no adult content until the correct PIN is entered.
// With no active search it shows the fixed +18 browse row so entering the
// section already surfaces all the adult content, not a blank search box.

function toAdultPosterItem(entry: AdultRowItem): PosterItem {
  return {
    id: entry.title,
    title: entry.title,
    imageUrl: entry.posterUrl,
  };
}

// Downloaded +18 titles are real Jellyfin library items. Carry the Jellyfin id
// (not a TMDB id) so the card plays them straight from the "Adultos" library -
// there is no TMDB/detail page for this content.
function toDownloadedPosterItem(item: JellyfinItem, token: string | null): PosterItem {
  return {
    id: item.Id,
    title: displayTitle(item.Name),
    imageUrl: jellyfinPosterUrl(item, token),
    mediaType: item.Type === 'Series' ? 'tv' : 'movie',
  };
}

export function AdultSearchScreen() {
  const navigate = useNavigate();
  const unlocked = useAdultUnlocked();
  const [query, setQuery] = useState('');
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  // Hooks run unconditionally (rules of hooks); both queries gate on the
  // in-memory unlock flag, so nothing fetches while the screen is locked.
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const { debouncedQuery, enabled, isLoading, isError, items, refetch } = useAdultSearch(query);
  const browse = useAdultRow();
  // Already-downloaded +18 titles (the Jellyfin "Adultos" library). This is
  // the reliable, always-populated shelf - Prowlarr's browse row needs a
  // configured API key and can come back empty, so downloaded content is
  // shown first so entering the section is never blank.
  const downloaded = useAdultLibraryItems();

  const searchItems = useMemo(() => items.map(toAdultPosterItem), [items]);
  const browseData = useMemo(() => browse.data ?? [], [browse.data]);
  const browseItems = useMemo(() => browseData.map(toAdultPosterItem), [browseData]);
  const downloadedItems = useMemo(
    () => (downloaded.data ?? []).map((item) => toDownloadedPosterItem(item, token)),
    [downloaded.data, token],
  );

  // With no active search, the browse row is the "active" list; otherwise the
  // search results are. The preview panel follows the active list, with the
  // same "auto-select first result" fallback as `SearchScreen.tsx`.
  const activeItems = enabled ? items : browseData;
  const selectedEntry =
    (selectedTitle != null ? activeItems.find((entry) => entry.title === selectedTitle) : undefined) ??
    activeItems[0] ??
    null;

  // Locked (direct visit / reload): show only the PIN gate. On a correct PIN
  // the in-memory flag flips and this component re-renders into the unlocked
  // view below; on cancel (Escape / backdrop) we send the user back Home.
  // `isAdultUnlocked()` is read live so the success path (which also calls
  // `onClose`) does NOT navigate away.
  if (!unlocked) {
    return (
      <main className="pf-adult-search">
        <Header />
        <AdultPinOverlay
          open
          onClose={() => {
            if (!isAdultUnlocked()) navigate('/');
          }}
        />
      </main>
    );
  }

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

      {enabled ? (
        <Row
          title="Resultados"
          items={searchItems}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => refetch()}
          renderItem={(item) => (
            <PosterCard key={item.id} item={item} onFocus={() => setSelectedTitle(item.id)} />
          )}
          emptyMessage={`Sin resultados para "${debouncedQuery}"`}
        />
      ) : (
        <>
          {/* Downloaded first: real Jellyfin items, clicking plays them
              directly (`/player/:jellyfinId`), same as Continue Watching. */}
          <Row
            title="Ya descargado"
            items={downloaded.isSuccess ? downloadedItems : undefined}
            isLoading={downloaded.isLoading}
            isError={downloaded.isError}
            onRetry={() => downloaded.refetch()}
            renderItem={(item) => (
              <PosterCard key={item.id} item={item} to={`/player/${item.id}`} />
            )}
            emptyMessage="Todavía no descargaste nada +18."
          />

          {/* Available to grab via Prowlarr. Clicking keeps you here and drives
              the preview panel below (its "Pedir" button does the grab). */}
          <Row
            title="Disponibles +18"
            items={browse.isSuccess ? browseItems : undefined}
            isLoading={browse.isLoading}
            isError={browse.isError}
            onRetry={() => browse.refetch()}
            renderItem={(item) => (
              <PosterCard
                key={item.id}
                item={item}
                to="/search_adult"
                onFocus={() => setSelectedTitle(item.id)}
              />
            )}
            emptyMessage="No hay títulos +18 para pedir ahora mismo."
          />
        </>
      )}

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
