import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../../auth/AuthContext';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecommendationsRow, type RecommendationsRowProps } from './RecommendationsRow';
import type { MusicResultItem } from '../../api/schemas/music';
import { COARSE_POINTER, ruleInMedia } from '../../test/cssRules';

// The cards carry a like and a ⋮ menu, both of which reach the worker. Stub the
// module so pressing them is deterministic (and so the assertions about them
// *not* starting playback aren't racing a real fetch).
vi.mock('../../api/music', () => ({
  getRatings: vi.fn().mockResolvedValue({}),
  setTrackRating: vi.fn().mockResolvedValue(undefined),
  getMusicJob: vi.fn().mockResolvedValue(null),
  requestDownload: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
}));

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

// The green play disc stays — the owner never asked for it to go — but it moved
// from the artwork's bottom-right corner to dead centre ("el boton de play
// deberia estar en el centro"). These cover what centring must not break: the
// button still plays, still pauses, is still reachable from the keyboard, and
// the like sharing that cover with it still does its own job.
describe('RecommendationsRow — the play button on the artwork', () => {
  it('centres the play disc on the cover instead of pinning it to a corner', () => {
    const { container } = renderRow();

    const btn = container.querySelector('.pf-music__rec-btn') as HTMLElement;
    expect(btn).not.toBeNull();
    // The class is what carries the position; assert the contract the CSS
    // implements rather than computed styles jsdom does not resolve.
    const css = readFileSync(resolve(__dirname, 'music.css'), 'utf8');
    const rule = css.slice(css.indexOf('.pf-music__rec-btn {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('top: 50%');
    expect(body).toContain('left: 50%');
    expect(body).not.toContain('bottom: 8px');
    expect(body).not.toContain('right: 8px');
    // Centring rides inside the transform, so the hidden/shown states must keep
    // the -50%/-50% or the disc jumps off-centre as it fades in.
    expect(body).toContain('translate(-50%, calc(-50% + 8px))');
  });

  it('plays the card from its button, keeping the same label', () => {
    const onPreview = vi.fn();
    renderRow({ onPreview });

    // Not downloaded (no jellyfinItemId) -> the preview path.
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir Rec 0 sin descargar' }));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview.mock.calls[0][0]).toMatchObject({ videoId: 'v0' });
  });

  it('plays from Jellyfin when the card is already downloaded', () => {
    const onPlay = vi.fn();
    const onPreview = vi.fn();
    renderRow({
      onPlay,
      onPreview,
      items: [
        { ...items[0], type: 'song' as const, downloaded: true, jellyfinItemId: 'aud-9' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reproducir Rec 0' }));

    expect(onPreview).not.toHaveBeenCalled();
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'v0' }), 'aud-9');
  });

  it('is reachable and activatable from the keyboard', async () => {
    const onPreview = vi.fn();
    renderRow({ onPreview });

    const btn = screen.getByRole('button', { name: 'Reproducir Rec 0 sin descargar' });
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn.tagName).toBe('BUTTON');

    // Enter and Space both fire a native button's click.
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    expect(onPreview).toHaveBeenCalledTimes(2);
  });

  it('keeps the sounding card visible and pauses it rather than restarting', () => {
    const onToggle = vi.fn();
    const onPreview = vi.fn();
    const { container } = renderRow({
      current: { itemId: 'v0', videoId: 'v0', title: 'Rec 0', artist: null, coverUrl: null },
      isPlaying: true,
      onToggle,
      onPreview,
    });

    // A pause button you can only reach by hovering is one the user cannot find.
    const buttons = container.querySelectorAll('.pf-music__rec-btn');
    expect(buttons[0].className).toContain('pf-music__rec-btn--active');
    expect(buttons[1].className).not.toContain('pf-music__rec-btn--active');

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('does not start playback when the like on the cover is pressed', async () => {
    const onPlay = vi.fn();
    const onPreview = vi.fn();
    renderRow({ onPlay, onPreview });

    await userEvent.click(screen.getByRole('button', { name: 'Me gusta Rec 0' }));

    expect(onPlay).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('does not start playback when the ⋮ menu is opened', async () => {
    const onPlay = vi.fn();
    const onPreview = vi.fn();
    renderRow({ onPlay, onPreview });

    await userEvent.click(screen.getByRole('button', { name: 'Más opciones para Rec 0' }));

    expect(onPlay).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('never nests a button inside another button', () => {
    const { container } = renderRow();

    for (const button of Array.from(container.querySelectorAll('button'))) {
      expect(button.querySelector('button')).toBeNull();
    }
  });
});

// Every test above presses the disc by role — and a button at `opacity: 0` with
// `pointer-events: auto` answers `getByRole`, `focus()` and `click()` exactly
// like a visible one. So the suite was green while the disc was invisible on
// every phone: it is revealed by `:hover`, and a phone never hovers. These
// tests ask the stylesheet the question the DOM cannot answer.
describe('RecommendationsRow — the play disc on a pointer that cannot hover', () => {
  const css = readFileSync(resolve(__dirname, 'music.css'), 'utf8');
  const touchRule = () => ruleInMedia(css, COARSE_POINTER, '.pf-music__rec-btn');

  it('reveals the disc without hover on coarse pointers', () => {
    const rule = touchRule();
    expect(
      rule,
      'no @media (hover: none)/(pointer: coarse) rule makes .pf-music__rec-btn visible',
    ).not.toBeNull();
    expect(rule?.declarations).toMatch(/opacity:\s*1\s*;/);
  });

  it('keeps the disc dead centre while revealing it', () => {
    // The centring lives inside the transform ("el boton de play deberia estar
    // en el centro"), so any state that writes `transform` has to restate it or
    // the disc slides off the artwork the moment it appears.
    expect(touchRule()?.declarations).toContain('transform: translate(-50%, -50%)');
  });

  it('matches the button the rail actually renders', () => {
    const { container } = renderRow();
    const btn = container.querySelector('.pf-music__rec-btn') as HTMLElement;

    // The selector as written in the file, not a paraphrase of it: a rule that
    // never matches the rendered button is the same bug wearing a new coat.
    expect(btn.matches(touchRule()?.selector ?? '')).toBe(true);
  });
});
