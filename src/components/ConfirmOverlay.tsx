import { useEffect, useId, useRef } from 'react';
import { OverlayShell } from './overlay/OverlayShell';
import './ConfirmOverlay.css';

// Shared destructive-action confirm dialog (design.md §2
// `components/ConfirmOverlay.tsx`), ported from the projector's
// `ConfirmOverlay.kt`. Visibility is owned by the caller (a plain `useState`
// on the caller's side, mirroring the Kotlin `remember mutableStateOf`) -
// this component only renders the dimmed backdrop + centered card while
// `open` is true. First consumers: Detail's delete/cancel confirms.
interface ConfirmOverlayProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  dismissLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
  /** Styles the confirm button as destructive (red/danger token). Defaults
   * to false for non-destructive confirms. */
  danger?: boolean;
}

export function ConfirmOverlay({
  open,
  title,
  message,
  confirmLabel,
  dismissLabel,
  onConfirm,
  onDismiss,
  danger = false,
}: ConfirmOverlayProps) {
  const titleId = useId();
  const dismissRef = useRef<HTMLButtonElement>(null);

  // The safe/dismiss button takes initial focus on open (mirrors BACK ==
  // dismiss on the projector: the default action is always the non-destructive
  // one unless the user explicitly moves off it).
  useEffect(() => {
    if (open) {
      dismissRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  // Dismissal (backdrop click, Escape, focus trap/return, scroll-lock) is
  // owned by the shared `OverlayShell` (design D: `sdd/mobile-music-overhaul`)
  // instead of a component-local `document` listener + manual `trapTabKey`
  // wiring - `.pf-confirm-overlay` keeps its existing dim/flex-center CSS as
  // OverlayShell's backdrop class.
  return (
    <OverlayShell variant="dialog" onDismiss={onDismiss} className="pf-confirm-overlay">
      <div
        className="pf-confirm-overlay__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="pf-confirm-overlay__title">
          {title}
        </h2>
        <p className="pf-confirm-overlay__message">{message}</p>
        <div className="pf-confirm-overlay__actions">
          <button
            ref={dismissRef}
            type="button"
            className="pf-confirm-overlay__button pf-confirm-overlay__button--dismiss"
            onClick={onDismiss}
          >
            {dismissLabel}
          </button>
          <button
            type="button"
            className={`pf-confirm-overlay__button pf-confirm-overlay__button--confirm${
              danger ? ' pf-confirm-overlay__button--danger' : ''
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </OverlayShell>
  );
}
