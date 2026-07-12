import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import './PosterCard.css';

// Reusable poster primitive (design.md §2 `components/PosterCard.tsx`) - Home
// is the first consumer, Search reuses the same component for its results
// carousel (Slice 5). Kept API-agnostic: callers map their own Jellyfin/
// Jellyseerr shape into this plain `PosterItem` before rendering.
export interface PosterItem {
  /** Routes to `/detail/:id`. This is the TMDB id when the source item has
   * one; see each caller's mapping note for the fallback used when it
   * doesn't (design.md §7 - Detail's `:id` is the TMDB id). */
  id: string;
  title: string;
  imageUrl: string | null;
  /** Optional status badge (LibraryIndex-driven) - Home's MVP rows don't
   * compute one; reserved for Search's InLibrary/Requesting/Requestable
   * join (design.md §4.4). */
  badge?: ReactNode;
}

interface PosterCardProps {
  item: PosterItem;
}

export function PosterCard({ item }: PosterCardProps) {
  const navigate = useNavigate();

  // A native <button> is real-tabindex + Enter/Space-activatable out of the
  // box (ADR-6: focus-friendly primitives, no mouse-only handlers) and is
  // also a plain click target for touch/mouse - no extra wiring needed for
  // either input mode.
  return (
    <button type="button" className="pf-poster-card" onClick={() => navigate(`/detail/${item.id}`)}>
      <span className="pf-poster-card__art">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" loading="lazy" />
        ) : (
          <span className="pf-poster-card__placeholder" aria-hidden="true">
            {item.title.charAt(0).toUpperCase()}
          </span>
        )}
        {item.badge && <span className="pf-poster-card__badge">{item.badge}</span>}
      </span>
      <span className="pf-poster-card__title">{item.title}</span>
    </button>
  );
}
