import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthProvider } from '../../auth/AuthContext';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecommendationsRow, type RecommendationsRowProps } from './RecommendationsRow';
import type { MusicResultItem } from '../../api/schemas/music';

// Desktop users can't move an overflow-x rail with a vertical-wheel mouse, so
// the rail must expose prev/next scroll arrows (like the main carousel). jsdom
// reports 0 for scroll metrics, so we stub the rail's dimensions to simulate an
// overflowing rail and assert the arrows appear and page the rail.

const items: MusicResultItem[] = Array.from({ length: 8 }, (_, i) => ({
  type: 'song' as const,
  videoId: `v${i}`,
  title: `Rec ${i}`,
  artist: `Artist ${i}`,
  artists: [],
  thumbnailUrl: `https://x/thumb${i}.jpg`,
}));

function renderRow(overrides: Partial<RecommendationsRowProps> = {}) {
  // Each card now embeds MusicRowMenu, which talks to react-query — the rails
  // had no per-song menu at all before, so there was no way from the feed to
  // like a track, queue it, or send it to a Jam.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
      <RecommendationsRow
        items={items}
        isLoading={false}
        onPlay={() => {}}
        onPreview={() => {}}
        {...overrides}
      />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Make the rail look horizontally overflowing at the given scroll position. */
function stubRailMetrics(rail: HTMLElement, scrollLeft: number, scrollWidth = 1200, clientWidth = 400) {
  Object.defineProperty(rail, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(rail, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(rail, 'scrollLeft', { configurable: true, writable: true, value: scrollLeft });
}

describe('RecommendationsRow — desktop scroll arrows', () => {
  // scrollByPage() consults matchMedia for prefers-reduced-motion; ensure a
  // stub exists (jsdom doesn't implement it) so clicking an arrow doesn't throw.
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the next arrow (and not prev) at the start of an overflowing rail', () => {
    const { container } = renderRow();
    const rail = container.querySelector('.pf-music__rail') as HTMLElement;
    stubRailMetrics(rail, 0);
    fireEvent.scroll(rail);

    expect(
      screen.getByRole('button', { name: 'Desplazar recomendados hacia adelante' }),
    ).toBeInTheDocument();
    // At scrollLeft 0 there is nothing to the left, so no back arrow.
    expect(
      screen.queryByRole('button', { name: 'Desplazar recomendados hacia atrás' }),
    ).not.toBeInTheDocument();
  });

  it('shows the prev arrow once scrolled away from the start', () => {
    const { container } = renderRow();
    const rail = container.querySelector('.pf-music__rail') as HTMLElement;
    stubRailMetrics(rail, 300);
    fireEvent.scroll(rail);

    expect(
      screen.getByRole('button', { name: 'Desplazar recomendados hacia atrás' }),
    ).toBeInTheDocument();
  });

  it('pages the rail by ~one viewport width when an arrow is clicked', () => {
    const scrollBy = vi.fn();
    const { container } = renderRow();
    const rail = container.querySelector('.pf-music__rail') as HTMLElement;
    stubRailMetrics(rail, 0);
    rail.scrollBy = scrollBy as unknown as HTMLElement['scrollBy'];
    fireEvent.scroll(rail);

    fireEvent.click(
      screen.getByRole('button', { name: 'Desplazar recomendados hacia adelante' }),
    );

    expect(scrollBy).toHaveBeenCalledTimes(1);
    const arg = scrollBy.mock.calls[0][0] as ScrollToOptions;
    // ~80% of the 400px viewport, scrolling forward (positive).
    expect(arg.left).toBeCloseTo(320);
  });

  it('renders no arrows when the rail is not overflowing', () => {
    const { container } = renderRow();
    const rail = container.querySelector('.pf-music__rail') as HTMLElement;
    stubRailMetrics(rail, 0, 400, 400); // content fits exactly
    fireEvent.scroll(rail);

    expect(
      screen.queryByRole('button', { name: 'Desplazar recomendados hacia adelante' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Desplazar recomendados hacia atrás' }),
    ).not.toBeInTheDocument();
  });
});
