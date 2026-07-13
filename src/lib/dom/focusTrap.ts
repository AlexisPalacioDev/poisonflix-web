import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

// Shared focus-trap helper for modal overlays (ConfirmOverlay, AdultPinOverlay,
// TrackMenu's scaffold). While a modal is open, Tab/Shift+Tab must cycle
// within the dialog instead of escaping to the page behind it - the standard
// "focus trap" contract for anything with `role="dialog"` + `aria-modal`.

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Returns every focusable element inside `container`, in DOM order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Keydown handler factory: when `event.key === 'Tab'` and focus is on the
 * first/last focusable element inside `container`, wraps focus to the
 * other end and prevents the default (which would otherwise move focus
 * outside the container). No-ops for any other key, and no-ops if the
 * container has no focusable elements.
 */
export function trapTabKey(
  container: HTMLElement,
  event: KeyboardEvent | ReactKeyboardEvent,
) {
  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }
}
