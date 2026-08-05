import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PoisonMark } from './PoisonMark';

// The mark is the only place the brand artwork lives, and it is inline SVG
// rather than an <img>, so nothing else in the app fails loudly if it breaks.
// These tests pin the contract the five call sites rely on: it renders, it is
// labelled, the `music` variant is visibly a different mark (not just a colour
// swap of the same one), and `className` reaches the <svg> so the per-screen
// CSS can size it.

describe('PoisonMark', () => {
  it('renders a labelled SVG for the video side', () => {
    const { container } = render(<PoisonMark />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
    expect(screen.getByRole('img', { name: 'PoisonFlix' })).toBe(svg);
  });

  it('swaps to the cassette mark and its own label for the music side', () => {
    const { container } = render(<PoisonMark variant="music" />);

    expect(screen.getByRole('img', { name: 'PoisonFlix Música' })).not.toBeNull();
    // The cassette carries the green accent; the clapper never does.
    expect(container.innerHTML).toContain('#57C838');
    expect(container.innerHTML).not.toContain('#E1152B');
  });

  it('draws a different shape per variant instead of recolouring one', () => {
    const video = render(<PoisonMark />).container.innerHTML;
    const music = render(<PoisonMark variant="music" />).container.innerHTML;

    expect(video).not.toEqual(music);
    expect(video).toContain('#E1152B');
  });

  it('forwards className so each screen can size the mark', () => {
    const { container } = render(<PoisonMark className="pf-header__mark" />);

    expect(container.querySelector('svg')).toHaveClass('pf-header__mark');
  });

  // No <image>, <use href>, or url() reference: the TV client must not make a
  // network request to draw its own logo.
  it('stays self-contained', () => {
    const { container } = render(<PoisonMark />);

    expect(container.innerHTML).not.toContain('<image');
    expect(container.innerHTML).not.toContain('href');
    expect(container.innerHTML).not.toContain('url(');
  });
});
