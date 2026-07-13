import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useAuth } from '../../hooks/useAuth';
import { useResumeRow } from '../../hooks/useResumeRow';
import { displayTitle } from '../../lib/domain/displayTitle';
import { jellyfinPosterUrl } from '../../lib/domain/posterUrl';

// Home's "Continuar viendo" row (projector-feature-map.md §3 row 1,
// walkthrough §2's "CONTINUAR VIENDO"). Unlike Home's other rows this one has
// no loading/error UI of its own - the native app only ever shows it "if
// state.continueWatching non-empty" (walkthrough §2), so it renders nothing
// at all until the resume feed has successfully returned at least one item.
//
// Progress percent is derived from PlaybackPositionTicks/RunTimeTicks rather
// than a `UserData.PlayedPercentage` field: the zod schema
// (api/schemas/jellyfin.ts) doesn't declare that field, so it would be
// silently stripped from the parsed response by zod's default non-strict
// parsing; the ticks ratio is equivalent data that IS already declared, and
// editing the schema is out of scope for this row.
function resumePercent(item: JellyfinItem): number | undefined {
  const positionTicks = item.UserData?.PlaybackPositionTicks;
  const totalTicks = item.RunTimeTicks;
  if (!positionTicks || !totalTicks) return undefined;
  return Math.min(100, Math.max(0, (positionTicks / totalTicks) * 100));
}

function toResumePosterItem(item: JellyfinItem, token: string | null): PosterItem {
  return {
    id: item.Id,
    title: displayTitle(item.Name),
    imageUrl: jellyfinPosterUrl(item, token),
    // Bar-only (dimUnwatched omitted -> defaults to false), per walkthrough §2:
    // "Every card has a thin amber progress bar under the poster".
    progressPercent: resumePercent(item),
  };
}

export function ContinueWatchingRow() {
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? null;
  const resume = useResumeRow();

  const items = (resume.data?.Items ?? []).map((item) => toResumePosterItem(item, token));
  if (items.length === 0) return null;

  return (
    <Row
      title="Continuar viendo"
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
