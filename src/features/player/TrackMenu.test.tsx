import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioTrackMenu } from './TrackMenu';
import type { MediaStreamTrack } from './mediaStreamTracks';

const tracks: MediaStreamTrack[] = [
  { index: 1, kind: 'Audio', language: 'eng', displayTitle: 'English', isDefault: true, isForced: false },
  { index: 2, kind: 'Audio', language: 'spa', displayTitle: 'Español', isDefault: false, isForced: false },
];

describe('TrackMenu (TrackMenuScaffold)', () => {
  it('opens with focus inside the sheet (on the first option)', () => {
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={() => {}} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveFocus();
  });

  it('calls onDismiss on Escape', () => {
    const onDismiss = vi.fn();
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={onDismiss} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('traps Tab: from the last control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={() => {}} />);

    const buttons = screen.getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});

describe('TrackMenu — shared dismissal (OverlayShell, design D)', () => {
  afterEach(() => {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
  });

  it('has aria-modal="true" alongside role="dialog"', () => {
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('clicking the backdrop (outside the sheet) dismisses', () => {
    const onDismiss = vi.fn();
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('dialog'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the sheet does not dismiss', () => {
    const onDismiss = vi.fn();
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={onDismiss} />);

    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('locks body scroll while open and releases it on unmount', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <AudioTrackMenu
          tracks={tracks}
          selectedIndex={1}
          onSelect={() => {}}
          onDismiss={() => setOpen(false)}
        />
      ) : null;
    }

    const { unmount } = render(<Harness />);
    expect(document.body.style.position).toBe('fixed');

    unmount();
    expect(document.body.style.position).toBe('');
  });

  it('returns focus to the element that opened it', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <AudioTrackMenu
              tracks={tracks}
              selectedIndex={1}
              onSelect={() => {}}
              onDismiss={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });
});

describe('TrackMenu — portal container (fullscreen blocker)', () => {
  // Real-Chrome audit finding: `OverlayShell` always portalled to
  // `document.body`, which took the track menu OUT of the real Fullscreen
  // API's element subtree entirely (per spec, only descendants of
  // `fullscreenElement` are shown - the menu simply never rendered) and
  // behind the pseudo-fullscreen surface's `z-index: 9999` on iOS Safari (the
  // menu's own z-index of 100 lost to it, painting behind the black
  // `<video>`). `container` lets the caller keep the menu inside the
  // player's fullscreen surface on both routes.
  //
  // jsdom implements neither the Fullscreen API nor real paint/stacking, so
  // this only verifies the portal TARGET is respected - not that a real
  // browser then shows the menu on top in either fullscreen mode. That part
  // is an on-device acceptance check, not something fakeable here.
  afterEach(() => {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
  });

  it('portals into document.body by default', () => {
    render(<AudioTrackMenu tracks={tracks} selectedIndex={1} onSelect={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('dialog').parentElement).toBe(document.body);
  });

  it('portals into the given container instead, e.g. the player fullscreen surface', () => {
    const surface = document.createElement('div');
    document.body.appendChild(surface);

    render(
      <AudioTrackMenu
        tracks={tracks}
        selectedIndex={1}
        onSelect={() => {}}
        onDismiss={() => {}}
        container={surface}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(surface);
    expect(dialog.parentElement).not.toBe(document.body);

    surface.remove();
  });
});

describe('AudioTrackMenu — una fila por idioma', () => {
  // La forma real de El Drama: cuatro pistas en inglés (TrueHD 7.1 por
  // defecto, AC3 5.1, AC3 estéreo, AC3 5.1). El menú las listaba como
  // "Inglés", "Inglés 2", "Inglés 3", "Inglés 4".
  const remux: MediaStreamTrack[] = [
    { index: 1, kind: 'Audio', language: 'eng', displayTitle: 'Surround 7.1 - English - Dolby TrueHD', isDefault: true, isForced: false },
    { index: 2, kind: 'Audio', language: 'eng', displayTitle: 'Surround 5.1 - English - Dolby Digital', isDefault: false, isForced: false },
    { index: 3, kind: 'Audio', language: 'eng', displayTitle: 'Stereo - English - Dolby Digital', isDefault: false, isForced: false },
    { index: 4, kind: 'Audio', language: 'eng', displayTitle: 'Surround 5.1 - English - Dolby Digital', isDefault: false, isForced: false },
  ];

  it('muestra una sola opción para las cuatro pistas en inglés', () => {
    render(<AudioTrackMenu tracks={remux} selectedIndex={1} onSelect={() => {}} onDismiss={() => {}} />);

    // Un botón por pista + el de cerrar; ahora debe quedar 1 + cerrar.
    expect(screen.queryByText('Inglés 2')).toBeNull();
    expect(screen.queryByText('Inglés 3')).toBeNull();
    expect(screen.queryByText('Inglés 4')).toBeNull();
  });

  it('la opción que queda es la pista por defecto del archivo, no otra', () => {
    const onSelect = vi.fn();
    render(<AudioTrackMenu tracks={remux} selectedIndex={1} onSelect={onSelect} onDismiss={() => {}} />);

    // Colapsar el menú no debe cambiar lo que suena: elegir la única fila
    // tiene que devolver la pista 1, la que el archivo marca por defecto.
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });
});
