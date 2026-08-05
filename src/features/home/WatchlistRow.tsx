import { PosterCard } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useWatchlist } from '../../hooks/useWatchlist';
import { toWatchlistPosterItem } from '../../lib/domain/posterItems';

// Home's "Mi lista" row (BFF-backed watchlist): titles the user saved to
// request/download later. Like Continue Watching it renders nothing until the
// list has at least one item. Title links to its "ver todo" grid (/watchlist),
// where each saved title can be downloaded.
export function WatchlistRow() {
  const watchlist = useWatchlist();

  const items = (watchlist.data ?? []).map(toWatchlistPosterItem);
  if (items.length === 0) return null;

  return (
    <Row
      title="Mi lista"
      titleTo="/watchlist"
      items={items}
      isLoading={false}
      isError={false}
      onRetry={() => watchlist.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage=""
    />
  );
}
