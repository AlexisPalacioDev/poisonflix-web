// D-pad focus movement for TV remotes.
//
// The app is built from natively focusable elements (PosterCard is a real
// <button>, nav uses <Link>), so the DOM was already reachable by Tab - what
// was missing is that a TV remote sends ArrowUp/Down/Left/Right, which no
// browser maps to focus movement. On the LG TV that meant the page just
// scrolled and nothing was ever selected.
//
// This is deliberately a DOM-level listener rather than a component library
// (Norigin et al.): those require wrapping every focusable in a hook, which
// would touch ~50 call sites and re-break every time a new screen is added.
// Geometry-based resolution keeps components untouched and works on screens
// written before this file existed.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type Dir = 'up' | 'down' | 'left' | 'right';

const KEY_TO_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** Text fields consume left/right (caret) and the player owns all four. */
function ownsArrowKeys(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'VIDEO') return true;
  return Boolean(el.closest('.pf-player-surface'));
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function candidates(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

interface Point {
  x: number;
  y: number;
}

function centerOf(el: HTMLElement): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Picks the nearest element in `dir`. The cross-axis offset is weighted far
 * heavier than the main-axis distance so a row of posters steps sideways one
 * card at a time instead of jumping diagonally to whatever happens to be
 * closest in raw pixels.
 */
function bestCandidate(from: HTMLElement, dir: Dir): HTMLElement | null {
  const origin = centerOf(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates()) {
    if (el === from) continue;
    const c = centerOf(el);
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;

    let main: number;
    let cross: number;
    if (dir === 'left' || dir === 'right') {
      main = dir === 'right' ? dx : -dx;
      cross = Math.abs(dy);
    } else {
      main = dir === 'down' ? dy : -dy;
      cross = Math.abs(dx);
    }

    // Must actually lie in the requested direction. The small threshold avoids
    // picking elements that merely overlap the origin's center line.
    if (main <= 8) continue;

    const score = main + cross * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Installs the listener. Returns a disposer (used by tests). */
export function installSpatialNavigation(target: Document = document): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const dir = KEY_TO_DIR[event.key];
    if (!dir || event.defaultPrevented) return;

    const active = target.activeElement as HTMLElement | null;
    if (ownsArrowKeys(active)) return;

    const all = candidates();
    if (all.length === 0) return;

    // Nothing focused yet (fresh page load, or focus fell to <body> after a
    // route change): adopt the first candidate instead of moving, so the very
    // first press lands somewhere visible rather than being swallowed.
    if (!active || active === target.body) {
      all[0].focus();
      event.preventDefault();
      return;
    }

    const next = bestCandidate(active, dir);
    if (!next) return;

    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Only prevented when focus actually moved, so an unhandled direction
    // still falls through to the browser's own scrolling.
    event.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
