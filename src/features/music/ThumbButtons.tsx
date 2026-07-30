import { useRatings } from '../../hooks/useRatings';
import './thumbs.css';

// 👍 / 👎 for a track, YouTube Music style: pressing the thumb you already have
// clears it, and the two are mutually exclusive. Rendered both in a row's ⋮ menu
// and in the NowPlayingBar, the two places YT Music puts them.
//
// A thumb-down is not decoration: the worker drops that videoId from every radio
// and recommendation it builds for this user afterwards.

function ThumbUpGlyph({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M7 10v10H4V10h3zm3 10V10l4-6a2 2 0 0 1 3 2l-1 4h4a2 2 0 0 1 2 2.4l-1.5 6A2 2 0 0 1 18.5 20H10z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThumbDownGlyph({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M17 14V4h3v10h-3zm-3-10v10l-4 6a2 2 0 0 1-3-2l1-4H4a2 2 0 0 1-2-2.4l1.5-6A2 2 0 0 1 5.5 4H14z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface ThumbButtonsProps {
  videoId: string;
  title: string;
  /** `menu` sits inside the ⋮ list; `bar` sits in the desktop NowPlayingBar;
   * `full` sits in the mobile full-screen player. */
  variant?: 'menu' | 'bar' | 'full';
}

export function ThumbButtons({ videoId, title, variant = 'menu' }: ThumbButtonsProps) {
  const { ratingFor, rate } = useRatings();
  const rating = ratingFor(videoId);

  // Pressing the thumb you already hold clears it — the same escape hatch YT
  // Music gives you, so a mis-tap is not permanent.
  const toggle = (value: 1 | -1) => rate(videoId, rating === value ? 0 : value);

  return (
    <div className={`pf-thumbs pf-thumbs--${variant}`}>
      <button
        type="button"
        className={`pf-thumbs__btn${rating === 1 ? ' pf-thumbs__btn--on' : ''}`}
        onClick={() => toggle(1)}
        aria-pressed={rating === 1}
        aria-label={`Me gusta ${title}`}
        title="Me gusta"
      >
        <ThumbUpGlyph filled={rating === 1} />
        {variant === 'menu' && <span>Me gusta</span>}
      </button>
      <button
        type="button"
        className={`pf-thumbs__btn${rating === -1 ? ' pf-thumbs__btn--off' : ''}`}
        onClick={() => toggle(-1)}
        aria-pressed={rating === -1}
        aria-label={`No me gusta ${title}`}
        title="No me gusta"
      >
        <ThumbDownGlyph filled={rating === -1} />
        {variant === 'menu' && <span>No me gusta</span>}
      </button>
    </div>
  );
}
