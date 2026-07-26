import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlayButton } from './PlayButton';

describe('PlayButton (icon-only play)', () => {
  it('renders an icon button with the aria-label and NO visible text', () => {
    render(<PlayButton onClick={() => {}} label="Reproducir Song One" />);

    const btn = screen.getByRole('button', { name: 'Reproducir Song One' });
    expect(btn).toBeInTheDocument();
    // Spotify-style icon: the label is accessible-only, the ▶ glyph is an SVG.
    expect(btn).toHaveTextContent('');
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('fires onClick when pressed', () => {
    const onClick = vi.fn();
    render(<PlayButton onClick={onClick} label="Reproducir Song One" />);

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir Song One' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
