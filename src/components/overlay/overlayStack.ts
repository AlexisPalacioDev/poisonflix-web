// Module-level overlay stack shared by every `OverlayShell` instance
// (design D: `sdd/mobile-music-overhaul`). Two jobs:
//
// 1. Escape-key ownership: with overlays nested (e.g. a confirm dialog opened
//    from inside the queue drawer), only the TOPMOST overlay should react to
//    Escape - the one underneath must stay open until the one above it closes.
// 2. Body scroll-lock, refcounted: nested overlays must not fight over
//    locking/unlocking the body scroll. The lock is applied on the first
//    `lockScroll()` call and released only on the `unlockScroll()` call that
//    brings the refcount back to zero.

type OverlayId = symbol;

interface OverlayEntry {
  id: OverlayId;
  sequence: number;
}

let stack: OverlayEntry[] = [];
let scrollLockCount = 0;
let savedScrollY = 0;
let nextSequence = 0;

// React commits effects bottom-up (child before parent), so two
// `OverlayShell`s that mount in the SAME commit (e.g. a dialog nested inside
// a drawer, both rendered in one state update) would register in the WRONG
// order if "topmost" were derived from push order alone - the inner one's
// effect runs first. Rendering itself, however, is top-down (parent before
// child), so a sequence number grabbed once per instance during render
// (before any effect runs) reflects the true visual nesting regardless of
// effect commit order.
export function nextOverlaySequence(): number {
  nextSequence += 1;
  return nextSequence;
}

export function pushOverlay(id: OverlayId, sequence: number): void {
  stack.push({ id, sequence });
}

export function popOverlay(id: OverlayId): void {
  stack = stack.filter((entry) => entry.id !== id);
}

export function isTopOverlay(id: OverlayId): boolean {
  if (stack.length === 0) return false;
  const top = stack.reduce((max, entry) => (entry.sequence > max.sequence ? entry : max));
  return top.id === id;
}

// iOS Safari IGNORES `overflow: hidden` on `body` while a fixed-position
// sheet is open - the page still scrolls underneath. The reliable fix is to
// pin the body itself with `position: fixed` at its current scroll offset,
// then restore both the styles AND the exact scroll position on unlock.
// Skipping the final `window.scrollTo` leaves the user stranded at the top
// of the page, which is a worse regression than the original bug.
export function lockScroll(): void {
  if (scrollLockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.width = '100%';
  }
  scrollLockCount += 1;
}

export function unlockScroll(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, savedScrollY);
  }
}

/** Test-only reset - clears the module-level stack and lock state between
 *  test cases so one test's overlays can never leak into the next. */
export function __resetOverlayStackForTests(): void {
  stack = [];
  scrollLockCount = 0;
  savedScrollY = 0;
  nextSequence = 0;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
}
