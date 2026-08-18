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
export function ownsArrowKeys(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'VIDEO') return true;
  // An open dialog is its own world, even when it is portalled INSIDE the
  // player's surface - which every player overlay is, because real Fullscreen
  // paints nothing outside `fullscreenElement`. Without this, a remote inside
  // a track/device sheet handed its arrows to the video underneath and could
  // not move between the options it was looking at.
  if (el.closest('[role="dialog"]')) return false;
  return Boolean(el.closest('.pf-player-surface'));
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** A dialog that renders the rest of the page unreachable while it is open. */
const MODAL_DIALOG = '[role="dialog"][aria-modal="true"]';

/**
 * The subtree the arrows are allowed to move within.
 *
 * `ownsArrowKeys` hands the arrows to this navigator whenever focus is inside
 * a dialog - without that, a remote inside a track/device sheet could not move
 * between the options it was looking at, because the player surface underneath
 * kept all four keys. But a modal dialog is a CLOSED world: everything behind
 * it is unreachable to a mouse and to Tab, so it has to be unreachable to the
 * D-pad too. `candidates()` queries the whole document and `bestCandidate`
 * scores by geometry alone, which knows nothing about modality - so a single
 * ArrowDown inside the sheet walked focus straight out to the player's back
 * button painted behind it. `OverlayShell`'s focus trap does not cover this:
 * it traps Tab, and the arrows never reach it.
 *
 * Scoped to `aria-modal="true"` rather than every `[role="dialog"]` on
 * purpose. A non-modal popup (the Jam notifications panel) does NOT make the
 * page behind it inert, and confining the arrows there would strand a remote
 * inside a panel the rest of the app is still supposed to be reachable from.
 */
function navigationRoot(from: Element | null): ParentNode {
  const enclosing = from?.closest(MODAL_DIALOG);
  if (enclosing) return enclosing;
  // Focus can also sit on <body> while a modal is open - a fresh mount, or a
  // dismissed child overlay that returned focus nowhere. Adopting the first
  // candidate in the document would then land BEHIND the dialog, which is the
  // one outcome that must not happen.
  //
  // With more than one modal open this picks the last in DOM order, and that is
  // a HEURISTIC, not the truth: `OverlayShell` portals into a caller-supplied
  // container (the player surface lives inside `#root`, everything else lands
  // on `document.body` after it), and `overlayStack` documents that mount order
  // is the wrong order too - it keeps its own render-time sequence for exactly
  // that reason. It cannot be reused here: that stack is keyed by symbols and
  // knows no DOM nodes.
  //
  // So the guarantee is only the one that matters: focus lands INSIDE some open
  // modal rather than on the page behind them. Landing in the wrong one of two
  // simultaneous modals is recoverable by pressing an arrow; landing behind
  // them all is the leak this whole function exists to close.
  const open = document.querySelectorAll<HTMLElement>(MODAL_DIALOG);
  return open.length > 0 ? open[open.length - 1] : document;
}

function candidates(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
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
function bestCandidate(from: HTMLElement, dir: Dir, root: ParentNode = document): HTMLElement | null {
  const origin = centerOf(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates(root)) {
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

    const root = navigationRoot(active);
    const all = candidates(root);
    if (all.length === 0) return;

    // Nothing focused yet (fresh page load, or focus fell to <body> after a
    // route change): adopt the first candidate instead of moving, so the very
    // first press lands somewhere visible rather than being swallowed.
    if (!active || active === target.body) {
      all[0].focus();
      event.preventDefault();
      return;
    }

    const next = bestCandidate(active, dir, root);
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
