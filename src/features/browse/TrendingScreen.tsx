import { PosterCard } from '../../components/PosterCard';
import { useTrendingRow } from '../../hooks/useTrendingRow';
import { trendingPosterItems } from '../../lib/domain/posterItems';
import { BrowseGrid } from './BrowseGrid';

// "Ver todo" grid for Home's "Tendencias" row. `trendingPosterItems` applies
// the exact same movie/tv filter + mapping Home uses, so the grid matches the
// rail it was opened from.
export function TrendingScreen() {
  const trending = useTrendingRow();

  const items = trendingPosterItems(trending.data?.results ?? []);

  return (
    <BrowseGrid
      title="Tendencias"
      items={trending.isSuccess ? items : undefined}
      isLoading={trending.isLoading}
      isError={trending.isError}
      onRetry={() => trending.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage="No hay tendencias para mostrar ahora mismo."
    />
  );
}
