import { Header } from '../../components/Header';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useLibraryRow } from '../../hooks/useLibraryRow';
import { useTrendingRow } from '../../hooks/useTrendingRow';
import { useAuth } from '../../hooks/useAuth';
import { jellyfinPosterUrl, tmdbPosterUrl } from '../../lib/domain/posterUrl';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { JellyseerrSearchResult } from '../../api/schemas/jellyseerr';
import './home.css';

// Home screen (home spec's "Fixed MVP row set"): mounts EXACTLY the Library
// and Trending rows via two independent useQuery hooks (ADR-3). Deferred:
// Continue Watching, Downloading, genre rows, +18 PIN - see tasks.md Slice 4
// and the home spec's Deferred section.

function toLibraryPosterItem(item: JellyfinItem, token: string | null): PosterItem {
  return {
    // Detail's route param is a TMDB id (design.md §7). A library item
    // normally carries one via ProviderIds.Tmdb; when it doesn't, fall back
    // to the Jellyfin item id so the card is still clickable - Detail's real
    // TMDB-based fetch is Slice 6 work, out of this slice's scope, so this
    // fallback is a flagged simplification, not a silent gap.
    id: item.ProviderIds?.Tmdb ?? item.Id,
    title: item.Name,
    imageUrl: jellyfinPosterUrl(item, token),
  };
}

function toTrendingPosterItem(result: JellyseerrSearchResult): PosterItem {
  return {
    id: String(result.id),
    title: result.title ?? result.name ?? 'Sin título',
    imageUrl: tmdbPosterUrl(result.posterPath),
  };
}

export function HomeScreen() {
  const { session } = useAuth();
  const library = useLibraryRow();
  const trending = useTrendingRow();

  const libraryItems = (library.data?.Items ?? []).map((item) =>
    toLibraryPosterItem(item, session?.jellyfinToken ?? null),
  );

  // Trending mixes movie/tv/person results; Home only shows titles a poster
  // + Detail route make sense for.
  const trendingItems = (trending.data?.results ?? [])
    .filter((result) => result.mediaType === 'movie' || result.mediaType === 'tv')
    .map(toTrendingPosterItem);

  return (
    <main className="pf-home">
      <Header />

      <Row
        title="Tu biblioteca"
        items={library.isSuccess ? libraryItems : undefined}
        isLoading={library.isLoading}
        isError={library.isError}
        onRetry={() => library.refetch()}
        renderItem={(item) => <PosterCard key={item.id} item={item} />}
        emptyMessage="Todavía no hay películas en tu biblioteca."
      />

      <Row
        title="Tendencias"
        items={trending.isSuccess ? trendingItems : undefined}
        isLoading={trending.isLoading}
        isError={trending.isError}
        onRetry={() => trending.refetch()}
        renderItem={(item) => <PosterCard key={item.id} item={item} />}
        emptyMessage="No hay tendencias para mostrar ahora mismo."
      />
    </main>
  );
}
