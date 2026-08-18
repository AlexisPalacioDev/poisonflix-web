import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GameCover } from './GameCover';

function renderCover(id: string, title: string) {
  const { container, ...rest } = render(<GameCover id={id} title={title} />);
  return { container, ...rest };
}

describe('GameCover', () => {
  it('asks the cover endpoint through the configurable BFF prefix', () => {
    const { container } = renderCover('g1', 'Super Metroid');
    const img = container.querySelector('img') as HTMLImageElement;

    // A hardcoded '/bff/...' would silently ignore VITE_BFF_BASE.
    expect(img.getAttribute('src')).toBe('/bff/games/cover?id=g1');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('percent-encodes an id that would otherwise break the query string', () => {
    const { container } = renderCover('snes/Chrono Trigger & Co.sfc', 'Chrono Trigger');
    const img = container.querySelector('img') as HTMLImageElement;

    expect(img.getAttribute('src')).toBe(
      '/bff/games/cover?id=snes%2FChrono%20Trigger%20%26%20Co.sfc',
    );
  });

  it('swaps a 404 for the game name on a coloured box, not a broken image', () => {
    const { container } = renderCover('g1', 'Super Metroid');
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    const fallback = container.querySelector('.pf-games__cover-fallback') as HTMLElement;
    expect(fallback).toHaveTextContent('Super Metroid');
    expect(fallback.style.backgroundImage).toContain('hsl(');
    // The card renders the same title as text right below the art; announcing
    // it twice would make every link in the grid stutter.
    expect(fallback.getAttribute('aria-hidden')).toBe('true');
  });

  it('derives the placeholder colour from the title, so it never reshuffles', () => {
    const first = renderCover('g1', 'Super Metroid');
    fireEvent.error(first.container.querySelector('img') as HTMLImageElement);
    const colourA = (
      first.container.querySelector('.pf-games__cover-fallback') as HTMLElement
    ).style.backgroundImage;

    // Same title, different id and a different render: same colour.
    const again = renderCover('g9', 'Super Metroid');
    fireEvent.error(again.container.querySelector('img') as HTMLImageElement);
    expect(
      (again.container.querySelector('.pf-games__cover-fallback') as HTMLElement).style
        .backgroundImage,
    ).toBe(colourA);

    // A different title gets its own, so a wall of coverless games is still
    // scannable instead of one flat block.
    const other = renderCover('g2', 'Chrono Trigger');
    fireEvent.error(other.container.querySelector('img') as HTMLImageElement);
    expect(
      (other.container.querySelector('.pf-games__cover-fallback') as HTMLElement).style
        .backgroundImage,
    ).not.toBe(colourA);
  });

  it('retries for a different game reusing the slot', () => {
    const { container, rerender } = render(<GameCover id="g1" title="Super Metroid" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();

    // A slot stuck on the previous game's 404 would hide a cover that exists.
    rerender(<GameCover id="g2" title="Chrono Trigger" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/bff/games/cover?id=g2');
  });
});
