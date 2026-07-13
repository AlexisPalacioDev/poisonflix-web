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
