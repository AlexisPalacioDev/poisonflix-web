import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { trapTabKey } from '../../lib/dom/focusTrap';
import {
  isTopOverlay,
  lockScroll,
  nextOverlaySequence,
  popOverlay,
  pushOverlay,
  unlockScroll,
} from './overlayStack';

// Shared dismissal primitive for every overlay in the app (design D:
// `sdd/mobile-music-overhaul`). Renders a REAL, clickable backdrop DOM node in
// a portal rather than a `document` listener - the four overlays that already
// worked on touch (ConfirmOverlay, AdultPinOverlay, MusicRowMenu,
// AddToPlaylistButton) all had a real DOM node catching the tap; the one that
// used a bare `document.addEventListener('mousedown')` (Header) is the one
// suspected of failing on iOS Safari, where a tap on "non-clickable"
// background can skip `mousedown` entirely.
//
// Two shapes, chosen by `variant`:
//  - 'dialog': backdrop is a `<div>` that also HOSTS the nested content
//    (a centered card, a slide-in sidebar, a full-bleed sheet...). Dismissal
//    on backdrop click relies on `event.target === event.currentTarget` so a
//    click bubbling up from inside the content never closes it.
//  - 'menu': backdrop is a standalone `<button>` catcher. When `anchorRef` +
//    `children` are given, the anchored dropdown panel is portalled TOGETHER
//    with the backdrop (panel after backdrop in DOM order) instead of being
//    left as a separate, non-portalled sibling next to the trigger. Without
//    `anchorRef`, it stays backdrop-only (a caller can still render its own
//    sibling panel, matching the older pattern) for backward compatibility.
//
// Why the anchored panel had to move into the SAME portal as the backdrop
// (post-mortem, real-Chrome audit): a `position: fixed` ancestor of the
// trigger (Header) - or even just a hover `transform` on an ancestor row
// (MusicRowMenu/AddToPlaylistButton) - creates its OWN stacking context.
// A panel left in place stays trapped INSIDE that context while a backdrop
// portalled straight to `document.body` escapes to the root one. If the two
// contexts tie or the root one wins, the backdrop paints OVER the entire
// panel and every item in it becomes unclickable - tapping any item just
// closes the menu instead of acting on it. Portalling both together, with
// the panel placed after the backdrop in the SAME container, makes the
// panel's position in the paint order deterministic regardless of what any
// ancestor's CSS does.
//
// Testing gotcha: jsdom does no layout and no paint, so it can neither
// reproduce this bug nor prove the fix visually. The tests around this
// module assert the STRUCTURAL invariant that makes correct stacking
// possible in a real browser (same portal container, panel after backdrop in
// DOM order) - real hit-testing/CSS-stacking verification is an on-device
// acceptance step, not something faked here as automated coverage.
//
// Behavior owned centrally, once, for both shapes:
//  - Escape closes the overlay, but ONLY if it is the topmost one on the
//    shared `overlayStack` (so a dialog opened from inside a drawer doesn't
//    also close the drawer underneath it).
//  - Tab/Shift+Tab is trapped inside the backdrop subtree for the 'dialog'
//    variant only (reuses `trapTabKey` from `lib/dom/focusTrap` - never
//    duplicated).
//  - The element that had focus right before the overlay opened regains
//    focus when the overlay unmounts, regardless of which dismissal path
//    triggered the close (backdrop click, Escape, or a close button inside
//    the content - they all unmount this component the same way).
//  - Body scroll is locked (refcounted via `overlayStack`) while at least one
//    overlay is open.

export type OverlayVariant = 'dialog' | 'menu';

export interface OverlayShellProps {
  variant: OverlayVariant;
  onDismiss: () => void;
  children?: ReactNode;
  /** Class name applied to the backdrop node itself - this is where callers
   *  keep their existing dimming/positioning CSS (e.g. `pf-confirm-overlay`,
   *  `pf-track-menu`, `pf-fullplayer`). */
  className?: string;
  ariaLabel?: string;
  /** Set when the backdrop node IS the dialog surface (TrackMenu,
   *  FullPlayer). Omit when a nested child owns its own `role="dialog"`
   *  (ConfirmOverlay, AdultPinOverlay, QueueDrawer). */
  role?: 'dialog';
  ariaModal?: boolean;
  /** Defaults to true. Set false for overlays with no "outside" concept
   *  (FullPlayer: full-bleed, dismissed only via Escape/its own controls). */
  dismissOnBackdropClick?: boolean;
  /** Portal target. Defaults to `document.body`. Needed when the overlay
   *  must stay inside a specific subtree instead - e.g. the player's
   *  fullscreen surface, so `TrackMenu` still renders inside the real
   *  Fullscreen API's element (otherwise never painted at all) and above a
   *  pseudo-fullscreen surface's high z-index (otherwise painted behind the
   *  video). */
  container?: Element | null;
  /** 'menu' variant only. Ref to the trigger element the panel (`children`)
   *  should be anchored below. When given, OverlayShell measures the
   *  trigger's on-screen position and portals the panel as a
   *  `position: fixed` sibling of the backdrop, in the SAME container -
   *  see the module doc comment above for why. Omit to keep the older
   *  backdrop-only shape (caller renders its own sibling panel). */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Class name applied to the anchored panel's positioning wrapper (menu
   *  variant + `anchorRef` only). The wrapper only carries position - visual
   *  styling (background, padding, radius...) stays on the caller's own
   *  element passed as `children`. */
  panelClassName?: string;
  /** Gap, in pixels, between the trigger's bottom edge and the anchored
   *  panel. Defaults to 8. */
  panelOffset?: number;
}

export function OverlayShell({
  variant,
  onDismiss,
  children,
  className,
  ariaLabel,
  role,
  ariaModal,
  dismissOnBackdropClick = true,
  container,
  anchorRef,
  panelClassName,
  panelOffset = 8,
}: OverlayShellProps) {
  // Lazy initializers run once, synchronously, during THIS component's own
  // render - before any child's mount effect can run (React commits effects
  // bottom-up). That ordering matters: some content (e.g. TrackMenuScaffold)
  // moves focus to its first option on mount, and if we captured
  // `document.activeElement` in an effect instead, we'd wrongly capture that
  // first option as "the opener" rather than the button that actually opened
  // the overlay.
  const [id] = useState<symbol>(() => Symbol('overlay'));
  // Grabbed once, at render time (parent-before-child), so nesting order
  // survives even though effects that actually register the overlay commit
  // child-before-parent - see `nextOverlaySequence`'s doc comment.
  const [sequence] = useState<number>(() => nextOverlaySequence());
  const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);
  const backdropRef = useRef<HTMLDivElement | HTMLButtonElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | undefined>(undefined);
  const panelBoxRef = useRef<HTMLDivElement>(null);
  const corrected = useRef(false);

  // Measured once, synchronously before paint, from the trigger's actual
  // on-screen position - the panel is portalled away from wherever it sits
  // in the React tree, so it can no longer rely on a local
  // `position: relative` ancestor to anchor itself. Body scroll is locked
  // for the overlay's whole lifetime (below), so the trigger cannot move
  // under the user while the panel is open and a one-time measurement is
  // enough - no scroll/resize tracking needed.
  useLayoutEffect(() => {
    if (variant !== 'menu' || !anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();

    // Sitting after the backdrop in the DOM is NOT enough. Document order only
    // breaks ties between elements at the same z-index, and the backdrop always
    // carries one from its own class (100 on the header, 40 in the music rows)
    // while this wrapper would default to `auto`. A positive z-index paints in
    // a later step than `auto`, so the backdrop covered the whole panel and
    // every tap dismissed instead of activating — the exact bug this component
    // was introduced to kill, reintroduced through a different mechanism.
    //
    // Measuring the backdrop and sitting one above it keeps the guarantee here
    // instead of in each caller's stylesheet. A `panelClassName` the caller has
    // to remember is a rule that gets forgotten; this one cannot be.
    const backdropZ = backdropRef.current
      ? Number.parseInt(window.getComputedStyle(backdropRef.current).zIndex, 10)
      : Number.NaN;

    // Clamped to the viewport, both edges.
    //
    // Anchoring the panel's RIGHT to the trigger's right is correct for a
    // control in the top-right corner, and wrong everywhere else: a ⋮ on the
    // first card of a rail sits near the LEFT edge, so `innerWidth - rect.right`
    // is nearly the whole screen and the panel gets pushed off the left side.
    // The owner saw it cut by the screen edge; this is why.
    //
    // The panel's own width is not known until it renders, so this is the
    // first guess and the effect below corrects it once it can measure.
    const MARGIN = 8;
    const anchoredRight = Math.max(MARGIN, window.innerWidth - rect.right);

    setPanelStyle({
      position: 'fixed',
      top: rect.bottom + panelOffset,
      right: anchoredRight,
      maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
      zIndex: Number.isNaN(backdropZ) ? 1 : backdropZ + 1,
      // A phone in landscape has room for about four rows; without this the
      // last items overflow off-screen and the body scroll lock makes them
      // unreachable, so the menu can hide "Cerrar sesión" with no way back.
      maxHeight: `calc(100vh - ${Math.round(rect.bottom + panelOffset)}px - 8px)`,
      overflowY: 'auto',
    });
  }, [variant, anchorRef, panelOffset]);

  // Second pass, once the panel has a width: if the first guess put its left
  // edge off-screen, pull it back in. Measuring is the only way — a menu's
  // width depends on its longest label, which the caller owns.
  useLayoutEffect(() => {
    const panel = panelBoxRef.current;
    // Depends on `panelStyle` so it runs AFTER the first pass has produced one
    // — keyed off a ref instead, it fired once before any style existed and
    // then never again, which is why the clamp silently did nothing. A
    // one-shot flag is what keeps it from re-running on its own output.
    if (variant !== 'menu' || !panel || !panelStyle || corrected.current) return;
    const MARGIN = 8;
    const rect = panel.getBoundingClientRect();
    if (rect.left >= MARGIN && rect.right <= window.innerWidth - MARGIN) return;
    const right = Math.min(
      Math.max(MARGIN, window.innerWidth - rect.width - MARGIN),
      Math.max(MARGIN, window.innerWidth - rect.right + Number(panelStyle.right ?? 0)),
    );
    corrected.current = true;
    setPanelStyle((previous) => (previous ? { ...previous, right } : previous));
  }, [variant, panelStyle]);

  useEffect(() => {
    pushOverlay(id, sequence);
    lockScroll();
    return () => {
      popOverlay(id);
      unlockScroll();
      opener?.focus?.();
    };
    // `id`, `sequence`, and `opener` are stable for the lifetime of this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopOverlay(id)) {
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [id, onDismiss]);

  const handleBackdropClick = (event: ReactMouseEvent) => {
    if (dismissOnBackdropClick && event.target === event.currentTarget) {
      onDismiss();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (variant === 'dialog' && backdropRef.current) {
      trapTabKey(backdropRef.current, event);
    }
  };

  const node =
    variant === 'menu' ? (
      <>
        <button
          ref={backdropRef as React.Ref<HTMLButtonElement>}
          type="button"
          className={className}
          aria-label={ariaLabel}
          onClick={handleBackdropClick}
        />
        {/* Panel after the backdrop in DOM order on purpose - see the module
            doc comment for why this ordering is load-bearing, not cosmetic. */}
        {children && anchorRef ? (
          <div ref={panelBoxRef} className={panelClassName} style={panelStyle}>
            {children}
          </div>
        ) : null}
      </>
    ) : (
      <div
        ref={backdropRef as React.Ref<HTMLDivElement>}
        className={className}
        role={role}
        aria-modal={role === 'dialog' && ariaModal ? 'true' : undefined}
        aria-label={ariaLabel}
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    );

  return createPortal(node, container ?? document.body);
}
