import { Navigate, useParams } from 'react-router-dom';
import { PosterCard } from '../../components/PosterCard';
import { useAuth } from '../../hooks/useAuth';
import { useGenreRow } from '../../hooks/useGenreRow';
import { NORMAL_CATEGORIES } from '../../lib/domain/categories';
import { toGenreRowPosterItem } from '../../lib/domain/posterItems';
import { BrowseGrid } from './BrowseGrid';

// "Ver todo" grid for one Home genre row (reached from Row's `titleTo`). Reuses
// the exact same `useGenreRow` hook and `toGenreRowPosterItem` mapper the rail
// uses, so the full grid is guaranteed to match the rail it was opened from.
export function CategoryScreen() {
  const { id } = useParams<{ id: string }>();
  const category = NORMAL_CATEGORIES.find((c) => c.id === id);

  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  // Hook must run unconditionally (rules of hooks); when the category id is
  // unknown we pass a harmless placeholder and redirect below before render.
  const row = useGenreRow(category ?? NORMAL_CATEGORIES[0]);

  if (!category) return <Navigate to="/" replace />;

  const items = (row.data ?? []).map((entry) => toGenreRowPosterItem(entry, token));

  return (
    <BrowseGrid
      title={category.label}
      items={row.isSuccess ? items : undefined}
      isLoading={row.isLoading}
      isError={row.isError}
      onRetry={() => row.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage={`No hay títulos de ${category.label.toLowerCase()} para mostrar ahora mismo.`}
    />
  );
}
