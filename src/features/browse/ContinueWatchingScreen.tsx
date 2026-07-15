import { PosterCard } from '../../components/PosterCard';
import { useAuth } from '../../hooks/useAuth';
import { useResumeRow } from '../../hooks/useResumeRow';
import { toResumePosterItem } from '../../lib/domain/posterItems';
import { BrowseGrid } from './BrowseGrid';

// "Ver todo" grid for Home's "Continuar viendo" row. Same resume feed and
// mapper as the rail; like the rail, a card plays directly (`/player/:id`)
// rather than opening Detail (walkthrough §16).
export function ContinueWatchingScreen() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const resume = useResumeRow();

  const items = (resume.data?.Items ?? []).map((item) => toResumePosterItem(item, token));

  return (
    <BrowseGrid
      title="Continuar viendo"
      items={resume.isSuccess ? items : undefined}
      isLoading={resume.isLoading}
      isError={resume.isError}
      onRetry={() => resume.refetch()}
      renderItem={(item) => <PosterCard key={item.id} item={item} to={`/player/${item.id}`} />}
      emptyMessage="No tenés nada empezado para continuar."
    />
  );
}
