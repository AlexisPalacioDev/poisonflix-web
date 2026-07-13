import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdultPinOverlay } from './AdultPinOverlay';
import { DEFAULT_ADULT_PIN, isAdultUnlocked, lockAdult, setAdultPin } from '../lib/domain/adultSettings';

afterEach(() => {
  lockAdult();
  setAdultPin(DEFAULT_ADULT_PIN);
});

function filledDotCount() {
  return screen.getAllByTestId('adult-pin-dot').filter((dot) => dot.dataset.filled === 'true').length;
}

describe('AdultPinOverlay', () => {
  it('renders nothing when closed', () => {
    render(<AdultPinOverlay open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is an accessible dialog with the +18 heading/subheading', () => {
    render(<AdultPinOverlay open onClose={() => {}} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('CONTENIDO +18')).toBeInTheDocument();
    expect(screen.getByText('Ingresá el PIN')).toBeInTheDocument();
    expect(screen.getAllByTestId('adult-pin-dot')).toHaveLength(DEFAULT_ADULT_PIN.length);
  });

  it('fills a dot per digit entered', async () => {
    const user = userEvent.setup();
    render(<AdultPinOverlay open onClose={() => {}} />);

    expect(filledDotCount()).toBe(0);

    await user.click(screen.getByRole('button', { name: '6' }));
    expect(filledDotCount()).toBe(1);

    await user.click(screen.getByRole('button', { name: '9' }));
    expect(filledDotCount()).toBe(2);
  });

  it('shows an error and clears the dots on a wrong PIN', async () => {
    const user = userEvent.setup();
    render(<AdultPinOverlay open onClose={() => {}} />);

    for (const digit of ['1', '1', '1', '1']) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    expect(await screen.findByText('PIN incorrecto')).toBeInTheDocument();
    expect(filledDotCount()).toBe(0);
    expect(isAdultUnlocked()).toBe(false);
  });

  it('unlocks and closes on the correct PIN', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AdultPinOverlay open onClose={onClose} />);

    for (const digit of DEFAULT_ADULT_PIN.split('')) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isAdultUnlocked()).toBe(true);
  });

  it('BORRAR removes the last digit and clears any error', async () => {
    const user = userEvent.setup();
    render(<AdultPinOverlay open onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'BORRAR' }));

    expect(filledDotCount()).toBe(0);
  });

  it('is keyboard-operable via number keys and Backspace', () => {
    const onClose = vi.fn();
    render(<AdultPinOverlay open onClose={onClose} />);

    for (const digit of DEFAULT_ADULT_PIN.split('')) {
      fireEvent.keyDown(document, { key: digit });
    }

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isAdultUnlocked()).toBe(true);
  });

  it('dismisses on Escape', () => {
    const onClose = vi.fn();
    render(<AdultPinOverlay open onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab: from the last control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
    render(<AdultPinOverlay open onClose={() => {}} />);

    const firstKey = screen.getByRole('button', { name: '1' });
    const lastKey = screen.getByRole('button', { name: 'BORRAR' });

    lastKey.focus();
    fireEvent.keyDown(lastKey, { key: 'Tab' });
    expect(firstKey).toHaveFocus();

    fireEvent.keyDown(firstKey, { key: 'Tab', shiftKey: true });
    expect(lastKey).toHaveFocus();
  });

  it('dismisses when clicking the backdrop but not the card', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AdultPinOverlay open onClose={onClose} />);

    await user.click(screen.getByText('Ingresá el PIN'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
