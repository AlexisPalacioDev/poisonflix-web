import { useEffect, useRef, useState } from 'react';
import { getAdultPin, tryUnlock } from '../lib/domain/adultSettings';
import { OverlayShell } from './overlay/OverlayShell';
import './AdultPinOverlay.css';

// PIN gate for the +18 section (projector-feature-map.md §3, ported from
// `ui/home/AdultPinOverlay.kt`). Numeric keypad, no system IME needed - the
// same rationale that drove the Kotlin version (a TV remote has no
// keyboard) still applies here since the target hardware is a browser on a
// TV/projector, even though a real keyboard is also available. Auto-submits
// once the entered length matches the configured PIN's length
// (`AdultPinOverlay.kt`'s `pinLength`); a wrong PIN clears the entry and
// shows an inline error, mirroring the Kotlin `press()` function exactly.
interface AdultPinOverlayProps {
  open: boolean;
  onClose: () => void;
}

const KEYPAD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

export function AdultPinOverlay({ open, onClose }: AdultPinOverlayProps) {
  const [entered, setEntered] = useState('');
  const [error, setError] = useState(false);
  const firstKeyRef = useRef<HTMLButtonElement>(null);
  const pinLength = getAdultPin().length;

  // Reset entry state each time the overlay (re)opens, and focus the first
  // key (mirrors `AdultPinOverlay.kt`'s `LaunchedEffect(Unit) { firstKey.requestFocus() }`).
  useEffect(() => {
    if (open) {
      setEntered('');
      setError(false);
      firstKeyRef.current?.focus();
    }
  }, [open]);

  function press(digit: string) {
    if (digit === 'BACKSPACE') {
      setError(false);
      setEntered((prev) => prev.slice(0, -1));
      return;
    }

    if (entered.length >= pinLength) return;
    const next = entered + digit;
    setError(false);

    if (next.length === pinLength) {
      // Side effect belongs in the event handler, not a setState updater
      // (StrictMode double-invokes updaters - `tryUnlock` must run exactly once).
      if (tryUnlock(next)) {
        onClose();
      } else {
        setError(true);
        setEntered('');
      }
    } else {
      setEntered(next);
    }
  }

  // Number keys + Backspace drive the pad from a real keyboard (BACK/Escape
  // dismissal is now owned by the shared `OverlayShell` below, design D:
  // `sdd/mobile-music-overhaul`).
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Backspace') {
        press('BACKSPACE');
      } else if (/^[0-9]$/.test(event.key)) {
        press(event.key);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // `press` closes over `entered`/`pinLength` - resubscribing on every
    // keystroke keeps the keyboard path reading the current entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entered, pinLength]);

  if (!open) return null;

  // Dismissal (backdrop click, Escape, focus trap/return, scroll-lock) is
  // owned by the shared `OverlayShell` - `.pf-adult-pin` keeps its existing
  // dim/flex-center CSS as OverlayShell's backdrop class.
  return (
    <OverlayShell variant="dialog" onDismiss={onClose} className="pf-adult-pin">
      <div
        className="pf-adult-pin__card"
        role="dialog"
        aria-modal="true"
        aria-label="Contenido +18"
      >
        <p className="pf-adult-pin__heading">CONTENIDO +18</p>
        <h2 className="pf-adult-pin__subheading">Ingresá el PIN</h2>

        <div className="pf-adult-pin__dots">
          {Array.from({ length: pinLength }).map((_, i) => (
            <span
              key={i}
              data-testid="adult-pin-dot"
              data-filled={i < entered.length ? 'true' : 'false'}
              className={`pf-adult-pin__dot${i < entered.length ? ' pf-adult-pin__dot--filled' : ''}`}
            />
          ))}
        </div>

        <p className="pf-adult-pin__error" role="alert">
          {error ? 'PIN incorrecto' : ' '}
        </p>

        <div className="pf-adult-pin__keypad">
          {KEYPAD_ROWS.map((row, r) => (
            <div key={r} className="pf-adult-pin__row">
              {row.map((digit, c) => (
                <button
                  key={digit}
                  ref={r === 0 && c === 0 ? firstKeyRef : undefined}
                  type="button"
                  className="pf-adult-pin__key"
                  onClick={() => press(digit)}
                >
                  {digit}
                </button>
              ))}
            </div>
          ))}
          <div className="pf-adult-pin__row">
            <button type="button" className="pf-adult-pin__key" onClick={() => press('0')}>
              0
            </button>
            <button
              type="button"
              className="pf-adult-pin__key pf-adult-pin__key--wide"
              onClick={() => press('BACKSPACE')}
            >
              BORRAR
            </button>
          </div>
        </div>
      </div>
    </OverlayShell>
  );
}
