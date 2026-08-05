import { PosterCard } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useAuth } from '../../hooks/useAuth';
import { useFavoritesRow } from '../../hooks/useFavorites';
import { toLibraryPosterItem } from '../../lib/domain/posterItems';

// Home's "Mis favoritos" row (Jellyfin IsFavorite). Favorites reuse the library
// mapper (they ARE library items). Like Continue Watching, this row renders
// nothing until there is at least one favorite, so an empty shelf never
// clutters Home. Title links to its "ver todo" grid (/favorites).
export function FavoritesRow() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const favorites = useFavoritesRow();

  const items = (favorites.data?.Items ?? []).map((item) => toLibraryPosterItem(item, token));
  if (items.length === 0) return null;

  return (
    <Row
      title="Mis favoritos"
      titleTo="/favorites"
      items={items}
      isLoading={false}
      isError={false}
      onRetry={() => favorites.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage=""
    />
  );
}
