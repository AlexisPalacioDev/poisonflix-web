import { PosterCard } from '../../components/PosterCard';
import { useRemoveFromWatchlist, useWatchlist } from '../../hooks/useWatchlist';
import { toWatchlistPosterItem } from '../../lib/domain/posterItems';
import { BrowseGrid } from './BrowseGrid';

// "Ver todo" grid for Home's "Mi lista" row - the saved-for-later shelf.
// Tapping a card opens its Detail (where "Pedir" downloads it); press-and-hold
// removes it from the list (same long-press gesture as the Downloads screen's
// cancel, and reversible - re-saving from Detail puts it back - so no confirm).
export function WatchlistScreen() {
  const watchlist = useWatchlist();
  const remove = useRemoveFromWatchlist();

  const entries = watchlist.data ?? [];

  return (
    <BrowseGrid
      title="Mi lista"
      items={watchlist.isSuccess ? entries : undefined}
      isLoading={watchlist.isLoading}
      isError={watchlist.isError}
      onRetry={() => watchlist.refetch()}
      renderItem={(entry) => (
        <PosterCard
          key={`${entry.mediaType}-${entry.tmdbId}`}
          item={toWatchlistPosterItem(entry)}
          onLongClick={() => remove.mutate({ tmdbId: entry.tmdbId, mediaType: entry.mediaType })}
        />
      )}
      emptyMessage="Tu lista está vacía. Guardá títulos con «Mi lista» para verlos acá y descargarlos cuando quieras."
    />
  );
}
