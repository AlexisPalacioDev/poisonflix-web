import { PosterCard } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useAuth } from '../../hooks/useAuth';
import { useGenreRow } from '../../hooks/useGenreRow';
import type { Category } from '../../lib/domain/categories';
import { toGenreRowPosterItem } from '../../lib/domain/posterItems';

// One of Home's 10 genre/category rows (projector-feature-map.md §3). A
// standalone component - rather than HomeScreen calling `useGenreRow` in a
// loop - because hooks can't be called conditionally/variably inside a loop;
// one instance of THIS component per `NORMAL_CATEGORIES` entry gives each
// genre its own unconditional, stable `useGenreRow` call instead. The title
// links to this genre's "ver todo" grid (`/category/:id`), which reuses the
// very same hook + mapper.

interface GenreRowProps {
  category: Category;
}

export function GenreRow({ category }: GenreRowProps) {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const row = useGenreRow(category);

  const items = (row.data ?? []).map((entry) => toGenreRowPosterItem(entry, token));

  return (
    <Row
      title={category.label}
      titleTo={`/category/${category.id}`}
      items={row.isSuccess ? items : undefined}
      isLoading={row.isLoading}
      isError={row.isError}
      onRetry={() => row.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage={`No hay títulos de ${category.label.toLowerCase()} para mostrar ahora mismo.`}
    />
  );
}
