import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
