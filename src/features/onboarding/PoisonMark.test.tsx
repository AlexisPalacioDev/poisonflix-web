import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PoisonMark } from './PoisonMark';

// The mark is the only place the brand artwork lives, and it is inline SVG
// rather than an <img>, so nothing else in the app fails loudly if it breaks.
//
// A note on what these tests can and cannot do: a first pass here asserted only
// that the two variants produced different markup. That passed while the music
// variant was the clapperboard recoloured green - different paths, same object.
// Comparing markup is worthless. So the shape assertions below name the parts
// that make each object recognisable (two tape reels for the cassette, the
// three-band slate for the clapper) via `data-part`, which is a claim a wrong
// drawing cannot satisfy by accident. Anything about how it *looks* still needs
// human eyes on a render.

describe('PoisonMark', () => {
  it('renders a labelled SVG for the video side', () => {
    const { container } = render(<PoisonMark />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
    expect(screen.getByRole('img', { name: 'PoisonFlix' })).toBe(svg);
  });

  it('renders the cassette under its own label for the music side', () => {
    const { container } = render(<PoisonMark variant="music" />);

    expect(screen.getByRole('img', { name: 'PoisonFlix Música' })).toBe(
      container.querySelector('svg'),
    );
  });

  it('draws the cassette with a pair of tape reels', () => {
    const { container } = render(<PoisonMark variant="music" />);

    const reels = Array.from(container.querySelectorAll('[data-part="reel"] > circle:first-child'));
    expect(reels).toHaveLength(2);
    // Mirrored across the shell's centre line, which is what reads as a
    // cassette rather than as a single lens or eye.
    const cx = reels.map((r) => Number(r.getAttribute('cx')));
    expect(cx[0]).toBe(-cx[1]);
    expect(cx[0]).not.toBe(0);
  });

  it('draws the clapper with its three-band slate and no reels', () => {
    const { container } = render(<PoisonMark />);

    expect(container.querySelectorAll('[data-part="stripe"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-part="reel"]')).toHaveLength(0);
  });

  it('keeps the two variants as different objects, not one recoloured', () => {
    const music = render(<PoisonMark variant="music" />).container;

    // The cassette must not inherit the clapper's slate, and the clapper must
    // not grow reels - covered above. Colour is the last difference, not the
    // only one.
    expect(music.querySelectorAll('[data-part="stripe"]')).toHaveLength(0);
    expect(music.innerHTML).toContain('#57C838');
    expect(music.innerHTML).not.toContain('#E1152B');
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
