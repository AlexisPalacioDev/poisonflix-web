import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmOverlay } from './ConfirmOverlay';

function renderOverlay(overrides: Partial<React.ComponentProps<typeof ConfirmOverlay>> = {}) {
  const onConfirm = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <ConfirmOverlay
      open
      title="Eliminar título"
      message="Esta acción no se puede deshacer."
      confirmLabel="Eliminar"
      dismissLabel="Cancelar"
      onConfirm={onConfirm}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { ...utils, onConfirm, onDismiss };
}

describe('ConfirmOverlay', () => {
  it('renders nothing when closed', () => {
    renderOverlay({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses the dismiss button on open (safe action takes initial focus)', () => {
    renderOverlay();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('calls onDismiss on Escape', () => {
    const { onDismiss } = renderOverlay();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when clicking the backdrop but not the card', async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderOverlay();

    await user.click(screen.getByText('Esta acción no se puede deshacer.'));
    expect(onDismiss).not.toHaveBeenCalled();

    await user.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderOverlay();

    await user.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('applies danger styling to the confirm button when danger is true', () => {
    renderOverlay({ danger: true });
    expect(screen.getByRole('button', { name: 'Eliminar' })).toHaveClass(
      'pf-confirm-overlay__button--danger',
    );
  });

  it('does not apply danger styling by default', () => {
    renderOverlay();
    expect(screen.getByRole('button', { name: 'Eliminar' })).not.toHaveClass(
      'pf-confirm-overlay__button--danger',
    );
  });

  it('is an accessible dialog labelled by its title', () => {
    renderOverlay();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Eliminar título');
  });

  it('traps Tab: from the last control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
    renderOverlay();
    const dismissBtn = screen.getByRole('button', { name: 'Cancelar' });
    const confirmBtn = screen.getByRole('button', { name: 'Eliminar' });

    confirmBtn.focus();
    fireEvent.keyDown(confirmBtn, { key: 'Tab' });
    expect(dismissBtn).toHaveFocus();

    fireEvent.keyDown(dismissBtn, { key: 'Tab', shiftKey: true });
    expect(confirmBtn).toHaveFocus();
  });

  // Shared dismissal via OverlayShell (design D: `sdd/mobile-music-overhaul`).
  it('locks body scroll while open and releases it when closed', () => {
    const { rerender } = renderOverlay();
    expect(document.body.style.position).toBe('fixed');

    rerender(
      <ConfirmOverlay
        open={false}
        title="Eliminar título"
        message="Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        dismissLabel="Cancelar"
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(document.body.style.position).toBe('');
  });

  it('returns focus to the element that opened it once closed', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <ConfirmOverlay
            open={open}
            title="Eliminar título"
            message="Esta acción no se puede deshacer."
            confirmLabel="Eliminar"
            dismissLabel="Cancelar"
            onConfirm={() => {}}
            onDismiss={() => setOpen(false)}
          />
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
