import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CoverImage } from './CoverImage';

// A cover URL can resolve (song → album → artist fallback) yet still 404 at
// load time, and YouTube thumbnails 404 too. CoverImage must degrade to the ♪
// placeholder on the img `error` event instead of the browser's broken-image
// glyph, and re-attempt the load when the `src` changes.

describe('CoverImage', () => {
  it('renders the <img> when a src is given', () => {
    const { container } = render(<CoverImage src="https://x/cover.jpg" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://x/cover.jpg');
    // No placeholder while the image is (optimistically) shown.
    expect(screen.queryByText('♪')).not.toBeInTheDocument();
  });

  it('renders the ♪ placeholder when src is null', () => {
    const { container } = render(<CoverImage src={null} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('♪')).toBeInTheDocument();
  });

  it('falls back to the ♪ placeholder when the image fails to load', () => {
    const { container } = render(<CoverImage src="https://x/404.jpg" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();

    // Simulate the broken/404 cover: the browser fires `error` on the <img>.
    fireEvent.error(img);

    // The broken <img> is gone; the ♪ placeholder took its place.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('♪')).toBeInTheDocument();
  });

  it('re-attempts the load (recovers) when the src changes after a failure', () => {
    const { container, rerender } = render(<CoverImage src="https://x/404.jpg" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();

    // A new track/cover: the failed state must reset so the new URL is tried.
    rerender(<CoverImage src="https://x/good.jpg" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://x/good.jpg');
    expect(screen.queryByText('♪')).not.toBeInTheDocument();
  });

  it('applies the placeholder class so each context keeps its look', () => {
    render(<CoverImage src={null} placeholderClassName="pf-nowplaying__art-placeholder" />);
    expect(screen.getByText('♪')).toHaveClass('pf-nowplaying__art-placeholder');
  });
});
