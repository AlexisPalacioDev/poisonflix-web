import { PosterCard } from '../../components/PosterCard';
import { useAuth } from '../../hooks/useAuth';
import { useLibraryRow } from '../../hooks/useLibraryRow';
import { toLibraryPosterItem } from '../../lib/domain/posterItems';
import { BrowseGrid } from './BrowseGrid';

// "Ver todo" grid for Home's "Tu biblioteca" row. Unlike Home it does NOT
// exclude the hero-featured title - "ver todo" means every item, so the whole
// library is shown here.
export function LibraryScreen() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const library = useLibraryRow();

  const items = (library.data?.Items ?? []).map((item) => toLibraryPosterItem(item, token));

  return (
    <BrowseGrid
      title="Tu biblioteca"
      items={library.isSuccess ? items : undefined}
      isLoading={library.isLoading}
      isError={library.isError}
      onRetry={() => library.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage="Todavía no hay nada en tu biblioteca."
    />
  );
}
