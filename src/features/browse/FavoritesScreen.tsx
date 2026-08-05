import { PosterCard } from '../../components/PosterCard';
import { useAuth } from '../../hooks/useAuth';
import { useFavoritesRow } from '../../hooks/useFavorites';
import { toLibraryPosterItem } from '../../lib/domain/posterItems';
import { BrowseGrid } from './BrowseGrid';

// "Ver todo" grid for Home's "Mis favoritos" row. Same Jellyfin IsFavorite feed
// and mapper as the rail.
export function FavoritesScreen() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const favorites = useFavoritesRow();

  const items = (favorites.data?.Items ?? []).map((item) => toLibraryPosterItem(item, token));

  return (
    <BrowseGrid
      title="Mis favoritos"
      items={favorites.isSuccess ? items : undefined}
      isLoading={favorites.isLoading}
      isError={favorites.isError}
      onRetry={() => favorites.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage="Todavía no marcaste ningún favorito. Tocá el ⭐ en un título que ya tengas."
    />
  );
}
