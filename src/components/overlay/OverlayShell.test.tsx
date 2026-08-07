import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayShell } from './OverlayShell';

// Shared dismissal primitive (design D: `sdd/mobile-music-overhaul`). Backs
// every overlay in the app - a real, clickable backdrop DOM node (not a
// `document` listener), Escape scoped to the topmost overlay, a returned
// focus on close, and a refcounted body scroll-lock.

afterEach(() => {
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
});

describe('OverlayShell - dialog variant', () => {
  it('clicking the backdrop itself dismisses', () => {
    const onDismiss = vi.fn();
    render(
      <OverlayShell variant="dialog" onDismiss={onDismiss} className="backdrop" role="dialog" ariaModal>
        <div className="card">
          <button type="button">Inside</button>
        </div>
      </OverlayShell>,
    );

    fireEvent.click(screen.getByRole('dialog'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the nested content does NOT dismiss', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <OverlayShell variant="dialog" onDismiss={onDismiss} className="backdrop" role="dialog" ariaModal>
        <div className="card">
          <button type="button">Inside</button>
        </div>
      </OverlayShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Inside' }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('applies role="dialog" and aria-modal="true" to the backdrop node when requested', () => {
    render(
      <OverlayShell variant="dialog" onDismiss={() => {}} role="dialog" ariaModal ariaLabel="Reproduciendo">
        content
      </OverlayShell>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Reproduciendo' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('does not dismiss on backdrop click when dismissOnBackdropClick is false', () => {
    const onDismiss = vi.fn();
    render(
      <OverlayShell variant="dialog" onDismiss={onDismiss} role="dialog" dismissOnBackdropClick={false}>
        content
      </OverlayShell>,
    );

    fireEvent.click(screen.getByRole('dialog'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('traps Tab within the nested content', () => {
    render(
      <OverlayShell variant="dialog" onDismiss={() => {}} role="dialog">
        <button type="button">First</button>
        <button type="button">Last</button>
      </OverlayShell>,
    );

    const buttons = screen.getAllByRole('button');
    const [first, last] = buttons;

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('returns focus to the element that was focused before it opened, on unmount', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <OverlayShell variant="dialog" onDismiss={() => setOpen(false)} role="dialog">
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </OverlayShell>
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(opener).toHaveFocus();
  });

  it('locks body scroll on mount and releases it on unmount', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <OverlayShell variant="dialog" onDismiss={() => setOpen(false)} role="dialog">
          content
        </OverlayShell>
      ) : null;
    }

    const { unmount } = render(<Harness />);
    expect(document.body.style.position).toBe('fixed');

    unmount();
    expect(document.body.style.position).toBe('');
  });
});

describe('OverlayShell - menu variant', () => {
  it('renders as a clickable button catcher with the given aria-label', () => {
    const onDismiss = vi.fn();
    render(<OverlayShell variant="menu" onDismiss={onDismiss} className="backdrop" ariaLabel="Cerrar menú" />);

    const backdrop = screen.getByRole('button', { name: 'Cerrar menú' });
    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// Regression coverage for the fullscreen-track-menu blocker: `OverlayShell`
// always portalled to `document.body`, which put content outside the real
// Fullscreen API's element entirely (never rendered) and behind a pseudo-
// fullscreen surface's z-index (visually hidden). A `container` prop lets a
// caller keep the overlay inside a specific subtree instead.
describe('OverlayShell - portal container', () => {
  it('defaults to portaling into document.body', () => {
    render(
      <OverlayShell variant="dialog" onDismiss={() => {}} role="dialog" ariaLabel="Test">
        content
      </OverlayShell>,
    );

    expect(screen.getByRole('dialog', { name: 'Test' }).parentElement).toBe(document.body);
  });

  it('portals into the given container instead of document.body when provided', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(
      <OverlayShell variant="dialog" onDismiss={() => {}} role="dialog" ariaLabel="Test" container={container}>
        content
      </OverlayShell>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Test' });
    expect(dialog.parentElement).toBe(container);
    expect(dialog.parentElement).not.toBe(document.body);

    container.remove();
  });
});

// Regression coverage for the Header hamburger-menu blocker: the backdrop
// used to portal to `document.body` alone while the caller rendered the
// anchored dropdown panel as a separate, non-portalled sibling next to the
// trigger. Because `.pf-header` is `position: fixed` (its own stacking
// context) the panel stayed trapped INSIDE that context while the backdrop
// escaped to the root one, so the backdrop (same z-index, later in the root
// context) painted over the entire panel - every menu item became
// unclickable, closing the menu instead of navigating.
//
// Fix: the 'menu' variant now accepts `children` + `anchorRef` and portals
// the backdrop AND the anchored panel TOGETHER into the same container, with
// the panel placed after the backdrop in DOM order. Real hit-testing and
// CSS stacking are NOT exercisable under jsdom (it does no layout and no
// paint), so these tests assert the structural invariant that makes correct
// stacking possible in a real browser - not the visual result itself.
describe('OverlayShell - menu variant with an anchored panel', () => {
  function Harness({ container }: { container?: Element | null } = {}) {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" ref={anchorRef} onClick={() => setOpen(true)}>
          Trigger
        </button>
        {open && (
          <OverlayShell
            variant="menu"
            onDismiss={() => setOpen(false)}
            className="backdrop"
            ariaLabel="Cerrar menú"
            anchorRef={anchorRef}
            container={container}
          >
            <div role="menu" aria-label="Panel">
              <button type="button">Item</button>
            </div>
          </OverlayShell>
        )}
      </>
    );
  }

  it('portals the panel into the same container as the backdrop, after it in DOM order', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    const backdrop = screen.getByRole('button', { name: 'Cerrar menú' });
    const panel = screen.getByRole('menu', { name: 'Panel' });
    // The panel is wrapped by a positioning-only `<div>` (fixed top/right
    // computed from the trigger's rect) - that wrapper is the actual
    // sibling of the backdrop inside the shared portal container.
    const panelWrapper = panel.parentElement;

    expect(backdrop.parentElement).toBe(document.body);
    expect(panelWrapper?.parentElement).toBe(document.body);
    // eslint-disable-next-line no-bitwise
    expect(backdrop.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('honors a custom container for the anchored panel too', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(<Harness container={container} />);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    const backdrop = screen.getByRole('button', { name: 'Cerrar menú' });
    const panel = screen.getByRole('menu', { name: 'Panel' });

    expect(backdrop.parentElement).toBe(container);
    expect(panel.parentElement?.parentElement).toBe(container);

    container.remove();
  });

  it('without an anchorRef, the menu variant stays backdrop-only (backward compatible)', () => {
    const onDismiss = vi.fn();
    render(<OverlayShell variant="menu" onDismiss={onDismiss} ariaLabel="Cerrar menú" />);

    expect(screen.getByRole('button', { name: 'Cerrar menú' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('OverlayShell - Escape and nested stacking', () => {
  it('Escape dismisses an open overlay', () => {
    const onDismiss = vi.fn();
    render(
      <OverlayShell variant="dialog" onDismiss={onDismiss} role="dialog">
        content
      </OverlayShell>,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Escape only dismisses the topmost overlay when two are nested', () => {
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();

    render(
      <OverlayShell variant="dialog" onDismiss={onDismissOuter} role="dialog" ariaLabel="outer">
        <OverlayShell variant="dialog" onDismiss={onDismissInner} role="dialog" ariaLabel="inner">
          content
        </OverlayShell>
      </OverlayShell>,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onDismissInner).toHaveBeenCalledTimes(1);
    expect(onDismissOuter).not.toHaveBeenCalled();
  });
});
