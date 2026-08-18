import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installSpatialNavigation, ownsArrowKeys } from './spatialNavigation';

// Who gets the D-pad's arrows: the surface under the focused element, or the
// spatial navigator. Getting this wrong on a TV means a remote that cannot
// move, which is indistinguishable from a frozen app.

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ownsArrowKeys', () => {
  it('gives arrows to a text field, for the caret', () => {
    const input = mount('<input type="text" />');
    expect(ownsArrowKeys(input)).toBe(true);
  });

  it('gives arrows to the player surface, for seek and volume', () => {
    mount('<div class="pf-player-surface"><button id="b">Pausar</button></div>');
    expect(ownsArrowKeys(document.getElementById('b'))).toBe(true);
  });

  // Every player overlay is portalled INSIDE the player surface, because real
  // Fullscreen paints nothing outside `fullscreenElement`. Letting the surface
  // keep the arrows there left a remote unable to move between the options of
  // the sheet it was looking at.
  it('does NOT give arrows to the player when focus is inside a dialog over it', () => {
    mount(
      '<div class="pf-player-surface"><div role="dialog"><button id="d">LG del living</button></div></div>',
    );
    expect(ownsArrowKeys(document.getElementById('d'))).toBe(false);
  });

  it('leaves ordinary page content to the navigator', () => {
    mount('<div><a id="a" href="/x">Ver</a></div>');
    expect(ownsArrowKeys(document.getElementById('a'))).toBe(false);
  });
});

// --- WHERE the arrows are allowed to land ----------------------------------
//
// `ownsArrowKeys` only decides who handles the key. Handing the arrows to this
// navigator inside a dialog is what lets a remote move between the options of
// a sheet at all - and it is also what let the very next ArrowDown walk OUT of
// the sheet into the player controls painted behind it: the candidate query
// spans the whole document and the score is pure geometry, which knows nothing
// about modality. `OverlayShell`'s focus trap does not cover it either; it
// traps Tab, and the arrows never reach it.
//
// jsdom does no layout, so every rect is 0x0 and every candidate would be
// dropped as invisible. The geometry below is declared by hand: it is the
// arrangement the leak was reproduced with, not decoration.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gives each element with a declared id its rect, and 0x0 to everything else,
 *  so only what this test placed on screen counts as a candidate. */
function layout(rects: Record<string, Rect>): void {
  HTMLElement.prototype.getBoundingClientRect = function boundingRect(this: HTMLElement) {
    const r = rects[this.id];
    const box = r
      ? { left: r.x, top: r.y, width: r.w, height: r.h }
      : { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    } as DOMRect;
  };
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('arrow navigation is confined to an open modal dialog', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let dispose: (() => void) | null = null;

  beforeAll(() => {
    // Not implemented by jsdom, and the handler calls it on every move.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = function scrollIntoView() {};
    }
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    document.body.innerHTML = '';
  });

  /** The reproduction: a sheet portalled INSIDE the player surface (as every
   *  player overlay is), with the player's own "Volver" button behind it. */
  function mountSheetOverPlayer(): void {
    document.body.innerHTML = `
      <div class="pf-player-surface">
        <button id="back" type="button">Volver</button>
        <div id="sheet" role="dialog" aria-modal="true">
          <button id="lg" type="button">LG del living</button>
          <button id="close" type="button">Cerrar</button>
        </div>
      </div>`;
    layout({
      // Behind the sheet, column-aligned with the options and NEARER than the
      // sheet's own second button - so it wins the geometric score outright if
      // nothing confines the search. Alignment matters as much as distance: the
      // cross-axis term is weighted x3, and an off-column "Volver" loses on its
      // own without any confinement, which would make this test see nothing.
      back: { x: 0, y: 400, w: 300, h: 40 },
      lg: { x: 0, y: 100, w: 300, h: 40 },
      close: { x: 0, y: 600, w: 300, h: 40 },
    });
  }

  it('does not let ArrowDown fall through to the player behind the sheet', () => {
    mountSheetOverPlayer();
    dispose = installSpatialNavigation(document);
    (document.getElementById('lg') as HTMLButtonElement).focus();

    press('ArrowDown');

    expect(document.activeElement?.id).toBe('close');
  });

  it('still moves between the options of the sheet, which is why it got the arrows', () => {
    mountSheetOverPlayer();
    dispose = installSpatialNavigation(document);
    (document.getElementById('lg') as HTMLButtonElement).focus();

    press('ArrowDown');
    press('ArrowUp');

    expect(document.activeElement?.id).toBe('lg');
  });

  // Focus can sit on <body> with a modal open - a fresh mount, or a dismissed
  // child overlay that returned focus nowhere. Adopting the first candidate in
  // the document would land behind the dialog.
  it('adopts an option inside the open dialog, not one behind it, from a cold start', () => {
    mountSheetOverPlayer();
    dispose = installSpatialNavigation(document);
    document.body.focus();

    press('ArrowDown');

    expect(document.activeElement?.id).toBe('lg');
  });

  // Two modals at once (a confirmation raised from inside a drawer). Which one
  // is on top cannot be read off the DOM - `OverlayShell` portals into
  // different containers and `overlayStack` keeps its own sequence for exactly
  // that reason - so the invariant asserted here is the one that is actually
  // guaranteed: focus never lands on the page behind BOTH of them.
  it('never adopts a candidate behind the modals when two are open', () => {
    document.body.innerHTML = `
      <div>
        <button id="page" type="button">Inicio</button>
        <div id="drawer" role="dialog" aria-modal="true">
          <button id="drawer-item" type="button">Quitar de la cola</button>
        </div>
        <div id="confirm" role="dialog" aria-modal="true">
          <button id="confirm-yes" type="button">Sí, quitar</button>
        </div>
      </div>`;
    layout({
      page: { x: 0, y: 0, w: 200, h: 40 },
      'drawer-item': { x: 0, y: 100, w: 200, h: 40 },
      'confirm-yes': { x: 0, y: 200, w: 200, h: 40 },
    });
    dispose = installSpatialNavigation(document);
    document.body.focus();

    press('ArrowDown');

    expect(['drawer-item', 'confirm-yes']).toContain(document.activeElement?.id);
  });

  it('leaves an ordinary page free to roam, with no modal to confine it', () => {
    document.body.innerHTML = `
      <div>
        <button id="top" type="button">Arriba</button>
        <button id="bottom" type="button">Abajo</button>
      </div>`;
    layout({ top: { x: 0, y: 0, w: 100, h: 40 }, bottom: { x: 0, y: 200, w: 100, h: 40 } });
    dispose = installSpatialNavigation(document);
    (document.getElementById('top') as HTMLButtonElement).focus();

    press('ArrowDown');

    expect(document.activeElement?.id).toBe('bottom');
  });

  // A non-modal popup (the Jam notifications panel) does NOT make the page
  // behind it inert, so confining the arrows there would strand a remote in it.
  it('does not confine the arrows to a dialog that is not modal', () => {
    document.body.innerHTML = `
      <div>
        <div id="panel" role="dialog"><button id="invite" type="button">Ver invitación</button></div>
        <button id="outside" type="button">Inicio</button>
      </div>`;
    layout({ invite: { x: 0, y: 0, w: 200, h: 40 }, outside: { x: 0, y: 200, w: 200, h: 40 } });
    dispose = installSpatialNavigation(document);
    (document.getElementById('invite') as HTMLButtonElement).focus();

    press('ArrowDown');

    expect(document.activeElement?.id).toBe('outside');
  });
});
