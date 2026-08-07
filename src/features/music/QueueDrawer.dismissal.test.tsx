import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { QueueDrawer } from './QueueDrawer';

// QueueDrawer is the real "sidebar" (`position:fixed; right:0; top:0`) and,
// per the audit, had NO click-outside and NO Escape - only its own X button.
// Migrating it to `OverlayShell` is step 1 of the shared dismissal rollout
// (design D: `sdd/mobile-music-overhaul`): highest value, zero regression
// risk, since there was no working behavior to break.

function renderDrawer(onClose = vi.fn()) {
  setSession({
    jellyfinToken: 'tok-1',
    jellyfinUserId: 'user-1',
    jellyseerrCookiePresent: true,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MusicPlayerProvider>
          <button type="button">Opener</button>
          <QueueDrawer onClose={onClose} />
        </MusicPlayerProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('QueueDrawer dismissal', () => {
  afterEach(() => {
    clearSession();
    localStorage.clear();
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
  });

  it('has role="dialog" and aria-modal="true"', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog', { name: 'Cola de reproducción' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('clicking the backdrop closes the drawer', () => {
    const onClose = renderDrawer();
    // The drawer's own root has role="dialog" and is nested inside the
    // backdrop - clicking the backdrop itself (not the drawer) must dismiss.
    const dialog = screen.getByRole('dialog', { name: 'Cola de reproducción' });
    const backdrop = dialog.parentElement as HTMLElement;

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the drawer content does not close it', () => {
    const onClose = renderDrawer();
    fireEvent.click(screen.getByText('Cola'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape closes the drawer', () => {
    const onClose = renderDrawer();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks body scroll while open', () => {
    renderDrawer();
    expect(document.body.style.position).toBe('fixed');
  });

  it('returns focus to the opener when it unmounts', () => {
    setSession({
      jellyfinToken: 'tok-1',
      jellyfinUserId: 'user-1',
      jellyseerrCookiePresent: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();

    function Wrapper({ open }: { open: boolean }) {
      return (
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <MusicPlayerProvider>
              <button type="button">Opener</button>
              {open && <QueueDrawer onClose={onClose} />}
            </MusicPlayerProvider>
          </AuthProvider>
        </QueryClientProvider>
      );
    }

    // Focus the trigger BEFORE the drawer mounts - OverlayShell captures
    // `document.activeElement` at open time, mirroring the real flow where a
    // button's own onClick opens the overlay while the button still has focus.
    const { rerender } = render(<Wrapper open={false} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();

    rerender(<Wrapper open />);
    rerender(<Wrapper open={false} />);
    expect(opener).toHaveFocus();
  });
});
