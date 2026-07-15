import { ContinueWatchingRow } from './ContinueWatchingRow';
import { DownloadingRow } from './DownloadingRow';
import { GenreRow } from './GenreRow';
import { Header } from '../../components/Header';
import { Hero, HeroSkeleton, type HeroFeature } from '../../components/Hero';
import { PosterCard } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useLibraryRow } from '../../hooks/useLibraryRow';
import { useTrendingRow } from '../../hooks/useTrendingRow';
import { useAuth } from '../../hooks/useAuth';
import { NORMAL_CATEGORIES } from '../../lib/domain/categories';
import { displayTitle } from '../../lib/domain/displayTitle';
import { toLibraryPosterItem, toTrendingPosterItem } from '../../lib/domain/posterItems';
import { jellyfinBackdropUrl, tmdbPosterUrl } from '../../lib/domain/posterUrl';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { JellyseerrSearchResult } from '../../api/schemas/jellyseerr';
import './home.css';

// Home screen (home spec's "Fixed MVP row set" + projector-feature-map.md §3's
// 10 mixed genre rows): a featured hero banner on top of the Continue
// Watching, Downloading, Library and Trending rows, then one row per
// `NORMAL_CATEGORIES` entry, each fed by an independent useQuery hook
// (ADR-3). Adult (+18) content is deliberately NOT on Home: it is reachable
// only through the Header's PIN-gated +18 button (-> `/search_adult`), so no
// adult title ever surfaces on Home or in Continue Watching.

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

// --- Featured-title selection for the hero ---------------------------------
// The hero is presentational; Home decides WHICH already-fetched title to
// feature. Preference order maximises both "looks premium" (a real backdrop)
// and "the primary action actually works" (a playable library item):
//   1. a library item with artwork  -> playable + real Jellyfin backdrop
//   2. a trending item with artwork  -> rich TMDB backdrop, detail-only
//   3. any library item              -> playable, gradient fallback
//   4. any trending item             -> detail-only, gradient fallback
// The chosen title is then excluded from the row it came from so it never
// appears twice on screen (Netflix-style spotlight).
interface Featured {
  feature: HeroFeature;
  libraryId?: string;
  trendingId?: number;
}

function libraryFeature(item: JellyfinItem, token: string | null): Featured {
  return {
    libraryId: item.Id,
    feature: {
      title: displayTitle(item.Name),
      overview: item.Overview ?? null,
      backdropUrl: jellyfinBackdropUrl(item, token),
      year: item.ProductionYear ?? parseYear(item.PremiereDate),
      rating: item.CommunityRating ?? null,
      detailTo: `/detail/${item.ProviderIds?.Tmdb ?? item.Id}${item.Type === 'Series' ? '?type=tv' : ''}`,
      playTo: `/player/${item.Id}`,
    },
  };
}

function trendingFeature(result: JellyseerrSearchResult): Featured {
  return {
    trendingId: result.id,
    feature: {
      title: result.title ?? result.name ?? 'Sin título',
      overview: result.overview ?? null,
      backdropUrl: tmdbPosterUrl(result.backdropPath, 'w1280'),
      year: parseYear(result.releaseDate ?? result.firstAirDate),
      rating: result.voteAverage ?? null,
      detailTo: `/detail/${result.id}${result.mediaType === 'tv' ? '?type=tv' : ''}`,
      playTo: null,
    },
  };
}

function pickFeatured(
  libraryItems: JellyfinItem[],
  trendingItems: JellyseerrSearchResult[],
  token: string | null,
): Featured | null {
  // The hero's primary action plays directly (playTo = /player/{itemId}), but a
  // whole-series id 500s on Jellyfin PlaybackInfo, so only MOVIES are eligible
  // to be featured - series still appear in the "Listas para ver" row below.
  const movies = libraryItems.filter((item) => item.Type !== 'Series');

  const libWithArt = movies.find(
    (item) => Boolean(item.ImageTags?.Primary) || (item.BackdropImageTags?.length ?? 0) > 0,
  );
  if (libWithArt) return libraryFeature(libWithArt, token);

  const trendWithArt = trendingItems.find((result) => Boolean(result.backdropPath));
  if (trendWithArt) return trendingFeature(trendWithArt);

  if (movies[0]) return libraryFeature(movies[0], token);
  if (trendingItems[0]) return trendingFeature(trendingItems[0]);
  return null;
}

export function HomeScreen() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const library = useLibraryRow();
  const trending = useTrendingRow();

  const libraryItemsRaw = library.data?.Items ?? [];
  // Trending mixes movie/tv/person results; Home only shows titles a poster
  // + Detail route make sense for.
  const trendingItemsRaw = (trending.data?.results ?? []).filter(
    (result) => result.mediaType === 'movie' || result.mediaType === 'tv',
  );

  const featured = pickFeatured(libraryItemsRaw, trendingItemsRaw, token);

  // Exclude the featured title from its source row so it never renders twice.
  const libraryItems = libraryItemsRaw
    .filter((item) => item.Id !== featured?.libraryId)
    .map((item) => toLibraryPosterItem(item, token));

  const trendingItems = trendingItemsRaw
    .filter((result) => result.id !== featured?.trendingId)
    .map(toTrendingPosterItem);

  // Only feature once both rows have settled, so the hero doesn't flip titles
  // as the two independent queries resolve at different times.
  const heroSettled = !library.isLoading && !trending.isLoading;

  return (
    <main className="pf-home">
      <Header />

      {heroSettled && featured ? <Hero feature={featured.feature} /> : <HeroSkeleton />}

      <div className="pf-home__rows">
        <ContinueWatchingRow />
        <DownloadingRow />

        <Row
          title="Tu biblioteca"
          titleTo="/library"
          items={library.isSuccess ? libraryItems : undefined}
          isLoading={library.isLoading}
          isError={library.isError}
          onRetry={() => library.refetch()}
          renderItem={(item) => <PosterCard key={item.id} item={item} />}
          emptyMessage="Todavía no hay nada en tu biblioteca."
        />

        <Row
          title="Tendencias"
          titleTo="/trending"
          items={trending.isSuccess ? trendingItems : undefined}
          isLoading={trending.isLoading}
          isError={trending.isError}
          onRetry={() => trending.refetch()}
          renderItem={(item) => <PosterCard key={item.id} item={item} />}
          emptyMessage="No hay tendencias para mostrar ahora mismo."
        />

        {NORMAL_CATEGORIES.map((category) => (
          <GenreRow key={category.id} category={category} />
        ))}
      </div>
    </main>
  );
}
