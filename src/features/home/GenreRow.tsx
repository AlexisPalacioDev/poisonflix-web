import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { StatusBadge } from '../../components/StatusBadge';
import { useAuth } from '../../hooks/useAuth';
import { useGenreRow, type GenreRowItem } from '../../hooks/useGenreRow';
import type { Category } from '../../lib/domain/categories';
import { jellyfinPosterUrl, tmdbPosterUrl } from '../../lib/domain/posterUrl';

// One of Home's 10 genre/category rows (projector-feature-map.md §3). A
// standalone component - rather than HomeScreen calling `useGenreRow` in a
// loop - because hooks can't be called conditionally/variably inside a loop;
// one instance of THIS component per `NORMAL_CATEGORIES` entry gives each
// genre its own unconditional, stable `useGenreRow` call instead.

function toGenreRowPosterItem(entry: GenreRowItem, token: string | null): PosterItem {
  const imageUrl = entry.jellyfinItem
    ? jellyfinPosterUrl(entry.jellyfinItem, token)
    : tmdbPosterUrl(entry.posterPath);

  return {
    id: entry.id,
    title: entry.title,
    imageUrl,
    // PEDIR pill only on unowned titles (projector-feature-map.md §3's
    // MediaRow badge rule) - InLibrary items render with no badge; anything
    // else (Requesting/Requestable) is still "not yet in your library".
    badge: entry.status.kind !== 'InLibrary' ? <StatusBadge variant="requestable" label="PEDIR" /> : undefined,
  };
}

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
      items={row.isSuccess ? items : undefined}
      isLoading={row.isLoading}
      isError={row.isError}
      onRetry={() => row.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} />}
      emptyMessage={`No hay títulos de ${category.label.toLowerCase()} para mostrar ahora mismo.`}
    />
  );
}
