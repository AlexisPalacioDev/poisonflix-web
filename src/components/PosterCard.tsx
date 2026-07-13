import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';
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
  /** Disambiguates the TMDB id at the detail route (`/detail/:id?type=`).
   * TV must be tagged so the detail screen fetches `/tv/{id}` not `/movie/{id}`
   * (TMDB reuses ids across namespaces). Omitted -> movie (back-compat). */
  mediaType?: 'movie' | 'tv';
  /** Optional status badge (LibraryIndex-driven) - Home's MVP rows don't
   * compute one; reserved for Search's InLibrary/Requesting/Requestable
   * join (design.md §4.4). */
  badge?: ReactNode;
  /** 0..100 watch/download progress (ported from `PosterCard.kt`'s
   * `progressPercent`), rendered as a thin gold bar over the bottom edge of
   * the poster. Omitted -> no bar (back-compat with Home/Search's MVP rows,
   * which don't compute one yet). */
  progressPercent?: number;
  /** When true AND `progressPercent` is set, dims the poster art on top of
   * the bar (the projector's watch-progress treatment). Defaults to false,
   * which renders the bar alone at full poster brightness. */
  dimUnwatched?: boolean;
}

interface PosterCardProps {
  item: PosterItem;
  /** Fired on focus/hover, BEFORE any navigation - Search's carousel uses
   * this to drive its big preview panel as the user moves across results
   * (search spec: "Selecting a result shows its preview"), without changing
   * Home's usage (optional, no-op when omitted). */
  onFocus?: (item: PosterItem) => void;
  /** Press-and-hold (~500ms), ported from `PosterCard.kt`'s D-pad long-press
   * (Downloads' cancel action is the first consumer). Fires via pointer
   * (mouse/touch) AND keyboard (holding Enter). Never swallows the SHORT
   * click/Enter, which still fires the normal navigation below. */
  onLongClick?: () => void;
  /** Overrides the default `/detail/:id` navigation target. Home's Continue
   * Watching row is the first consumer: an in-progress title plays directly
   * (`/player/:jellyfinItemId`) instead of opening Detail (walkthrough §16:
   * "Selecting an in-progress item from Continuar viendo skips any detail
   * screen and jumps straight into the Player"). Omitted -> unchanged
   * `/detail/:id` behavior (back-compat with every other caller). */
  to?: string;
}

const LONG_PRESS_MS = 500;

export function PosterCard({ item, onFocus, onLongClick, to }: PosterCardProps) {
  const navigate = useNavigate();
  // Timer id for the pending long-press, and a flag that survives past the
  // timer firing so the click/keyup that follows a completed long-press can
  // be told apart from a genuine short click (browsers still dispatch a
  // click after pointerup/keyup even when the press was held).
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimer.current != null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function startLongPressTimer() {
    if (!onLongClick) return;
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      longPressFired.current = true;
      onLongClick();
    }, LONG_PRESS_MS);
  }

  function performNavigate() {
    navigate(to ?? `/detail/${item.id}${item.mediaType === 'tv' ? '?type=tv' : ''}`);
  }

  function handleClick() {
    if (longPressFired.current) {
      // The long-press already ran its action - swallow the trailing click
      // so it doesn't ALSO navigate.
      longPressFired.current = false;
      return;
    }
    performNavigate();
  }

  function isActivationKey(key: string) {
    return key === 'Enter' || key === ' ';
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // Cards WITHOUT onLongClick keep the native <button> behavior untouched:
    // Enter fires `click` synchronously on keydown, Space fires it on keyup.
    if (!onLongClick || !isActivationKey(event.key)) return;

    // A native <button> would otherwise fire `click` on this very keydown
    // (Enter) or the matching keyup (Space), which would navigate away
    // BEFORE the long-press timer below ever gets its LONG_PRESS_MS window -
    // a keyboard/D-pad user could then never long-press. Suppressing the
    // default here defers activation to our own keyup handling instead.
    event.preventDefault();

    // `!event.repeat` -> only the first keydown of a hold starts the timer,
    // not every OS auto-repeat keydown while the key stays pressed.
    if (!event.repeat && longPressTimer.current == null) {
      startLongPressTimer();
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (!onLongClick || !isActivationKey(event.key)) return;

    if (longPressTimer.current != null) {
      // Released before the long-press fired - a genuine short press, so
      // perform the navigation ourselves (native activation was suppressed
      // above).
      clearLongPressTimer();
      performNavigate();
    } else {
      // The long-press timer already fired onLongClick - just reset the
      // flag; this keyup must not ALSO navigate.
      longPressFired.current = false;
    }
  }

  const dimmed = Boolean(item.dimUnwatched) && item.progressPercent != null;

  // A native <button> is real-tabindex + Enter/Space-activatable out of the
  // box (ADR-6: focus-friendly primitives, no mouse-only handlers) and is
  // also a plain click target for touch/mouse - no extra wiring needed for
  // either input mode.
  return (
    <button
      type="button"
      className="pf-poster-card"
      onClick={handleClick}
      onFocus={() => onFocus?.(item)}
      onMouseEnter={() => onFocus?.(item)}
      onPointerDown={startLongPressTimer}
      onPointerUp={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      <span className={`pf-poster-card__art${dimmed ? ' pf-poster-card__art--dim' : ''}`}>
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" loading="lazy" />
        ) : (
          <span className="pf-poster-card__placeholder" aria-hidden="true">
            {item.title.charAt(0).toUpperCase()}
          </span>
        )}
        {item.badge && <span className="pf-poster-card__badge">{item.badge}</span>}
        {item.progressPercent != null && (
          <span className="pf-poster-card__progress-track">
            <span
              className="pf-poster-card__progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, item.progressPercent))}%` }}
            />
          </span>
        )}
      </span>
      <span className="pf-poster-card__title">{item.title}</span>
    </button>
  );
}
