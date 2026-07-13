import { useEffect, useId, useRef } from 'react';
import { trapTabKey } from '../lib/dom/focusTrap';
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
  const cardRef = useRef<HTMLDivElement>(null);

  // The safe/dismiss button takes initial focus on open (mirrors BACK ==
  // dismiss on the projector: the default action is always the non-destructive
  // one unless the user explicitly moves off it).
  useEffect(() => {
    if (open) {
      dismissRef.current?.focus();
    }
  }, [open]);

  // BACK/Escape dismisses the overlay (`ConfirmOverlay.kt:56`).
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onDismiss();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      className="pf-confirm-overlay"
      onClick={(event) => {
        // Only the backdrop itself dismisses - clicks inside the card must
        // not bubble into this handler (the card stops propagation below).
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
    >
      <div
        ref={cardRef}
        className="pf-confirm-overlay__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (cardRef.current) trapTabKey(cardRef.current, event);
        }}
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
    </div>
  );
}
