import { PosterCard } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useAuth } from '../../hooks/useAuth';
import { useResumeRow } from '../../hooks/useResumeRow';
import { toResumePosterItem } from '../../lib/domain/posterItems';

// Home's "Continuar viendo" row (projector-feature-map.md §3 row 1,
// walkthrough §2's "CONTINUAR VIENDO"). Unlike Home's other rows this one has
// no loading/error UI of its own - the native app only ever shows it "if
// state.continueWatching non-empty" (walkthrough §2), so it renders nothing
// at all until the resume feed has successfully returned at least one item.
// The title links to `/resume`, its "ver todo" grid (same feed + mapper).

export function ContinueWatchingRow() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const resume = useResumeRow();

  const items = (resume.data?.Items ?? []).map((item) => toResumePosterItem(item, token));
  if (items.length === 0) return null;

  return (
    <Row
      title="Continuar viendo"
      titleTo="/resume"
      items={items}
      isLoading={false}
      isError={false}
      onRetry={() => resume.refetch()}
      // Clicking an in-progress title plays directly instead of opening
      // Detail (walkthrough §16): `to` overrides PosterCard's default
      // `/detail/:id` navigation with the Jellyfin item id's Player route.
      renderItem={(item) => <PosterCard key={item.id} item={item} to={`/player/${item.id}`} />}
      emptyMessage=""
    />
  );
}
