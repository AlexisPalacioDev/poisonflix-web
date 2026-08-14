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

// The green disc is gone: the artwork itself is the control now, and a glyph
// appears only on the cover of the track the player has loaded ("el boton de
// play y pausa solo se mostrara en la caratula de la cancion que este sonando
// actualmente … el boton sera solo un marcador de estado"). These cover what
// that must not break: the cover still plays, still pauses, is still reachable
// from the keyboard, and the like sharing it still does its own job.
describe('RecommendationsRow — the cover is the play control', () => {
  it('leaves every cover unmarked while nothing on the rail is playing', () => {
    const { container } = renderRow();

    // The whole point of the change: no ▶ on covers that are not sounding.
    expect(container.querySelectorAll('.pf-music__art-state')).toHaveLength(0);
    // …and yet every one of them is still pressable.
    expect(container.querySelectorAll('.pf-music__art-btn')).toHaveLength(items.length);
  });

  it('plays the card from its cover, keeping the same label', () => {
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

  it('marks only the sounding cover, and pauses it rather than restarting', () => {
    const onToggle = vi.fn();
    const onPreview = vi.fn();
    const { container } = renderRow({
      current: { itemId: 'v0', videoId: 'v0', title: 'Rec 0', artist: null, coverUrl: null },
      isPlaying: true,
      onToggle,
      onPreview,
    });

    // Exactly one glyph on the whole rail, and it is on the card that sounds.
    const cards = container.querySelectorAll('.pf-music__rec');
    expect(container.querySelectorAll('.pf-music__art-state')).toHaveLength(1);
    expect(cards[0].querySelector('.pf-music__art-state')).not.toBeNull();
    expect(cards[1].querySelector('.pf-music__art-state')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pausar Rec 0' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('is the cover that is the button, not a glyph sitting on it', () => {
    const { container } = renderRow({
      current: { itemId: 'v0', videoId: 'v0', title: 'Rec 0', artist: null, coverUrl: null },
      isPlaying: true,
    });

    // The marker must not be a second control: one button per cover, and the
    // glyph is hidden from the accessibility tree.
    const marker = container.querySelector('.pf-music__art-state') as HTMLElement;
    expect(marker.tagName).not.toBe('BUTTON');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(marker.closest('button')).toBe(container.querySelector('.pf-music__art-btn'));
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

// Every test above presses the cover by role — and a button at `opacity: 0`
// with `pointer-events: auto` answers `getByRole`, `focus()` and `click()`
// exactly like a visible one. That is how the disc this replaced shipped
// invisible to every phone: it was revealed by `:hover`, and a phone never
// hovers. The cover cannot inherit that bug, and these ask the stylesheet the
// question the DOM cannot answer.
describe('RecommendationsRow — the cover control needs no hover', () => {
  const css = readFileSync(resolve(__dirname, 'music.css'), 'utf8');
  const ruleBody = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    if (at === -1) return null;
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  };

  it('never hides the click surface', () => {
    const body = ruleBody('.pf-music__art-btn');
    expect(body, '.pf-music__art-btn has no rule at all').not.toBeNull();
    expect(body).toContain('position: absolute');
    expect(body).not.toMatch(/opacity:\s*0/);
  });

  it('never hides the status marker', () => {
    const body = ruleBody('.pf-music__art-state');
    expect(body, '.pf-music__art-state has no rule at all').not.toBeNull();
    expect(body).not.toMatch(/opacity:\s*0/);
  });

  it('leaves no hover-revealed disc behind', () => {
    // `.pf-music__rec-btn` is the class that cost this codebase the bug twice.
    // Nothing renders it any more; nothing should style it either.
    expect(css).not.toContain('pf-music__rec-btn');
  });

  it('does not gate the cover behind a coarse-pointer exception', () => {
    // The old disc needed one because it was hidden by default. A cover that is
    // always there needs none — and one appearing again would mean it is not.
    expect(ruleInMedia(css, COARSE_POINTER, '.pf-music__art-btn')).toBeNull();
  });
});

// A rail is not a reading column. `.pf-music__section` caps at 760px for the
// search *list*; the feed rails reused the class and inherited a cap meant for
// text, so five covers showed on a screen that fits twelve and the sixth was
// sliced at a hard edge. The modifier is what frees them, and nothing in the
// DOM can assert a max-width jsdom never resolves — so ask the stylesheet.
describe('RecommendationsRow — the rail runs the full width', () => {
  const css = readFileSync(resolve(__dirname, 'music.css'), 'utf8');
  const ruleBody = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    if (at === -1) return null;
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  };

  it('marks the section as a rail rather than a reading column', () => {
    const { container } = renderRow();
    const section = container.querySelector('section') as HTMLElement;

    expect(section.classList.contains('pf-music__section--rail')).toBe(true);
  });

  it('lifts the 760px reading cap off rail sections', () => {
    expect(ruleBody('.pf-music__section--rail')).toContain('max-width: none');
  });

  it('moves the page gutter inside the scroller so covers scroll under the fade', () => {
    const rail = ruleBody('.pf-music__rail') ?? '';

    // Padding on the section would stop the covers at a border; padding on the
    // scroller lets them pass beneath the mask, which is what says "there is
    // more over there" instead of "the layout is broken".
    expect(rail).toContain('padding: 20px var(--pf-gutter) 26px');
    expect(rail).toContain('mask-image');
    // Without this the first snap skips the gutter and the rail rests at
    // scrollLeft ≈ gutter, showing a "scroll back" arrow over empty space.
    expect(rail).toContain('scroll-padding-inline');
  });
});

// Albums and playlists ride the same feed as songs (MusicResultItem is a union
// discriminated on `type`), and RecommendationsRow mounts MusicCollectionCard
// with layout="rail" for them — a branch that had no test at all, which is how
// its download button spent who knows how long anchored to the wrong element.
describe('RecommendationsRow — collection cards on the rail', () => {
  const css = readFileSync(resolve(__dirname, 'music.css'), 'utf8');

  const album: MusicResultItem = {
    type: 'album' as const,
    browseId: 'MPREb_test',
    title: 'Un álbum',
    artist: 'Una artista',
    thumbnailUrl: 'https://x/album.jpg',
  };

  it('renders an album as a card on the rail, not as a list row', () => {
    const { container } = renderRow({ items: [album] });

    const card = container.querySelector('.pf-music__rail .pf-music__rec--coll');
    expect(card, 'the album never reached the rail as a collection card').not.toBeNull();
    expect(container.querySelector('.pf-music__row--coll')).toBeNull();
  });

  it('anchors the download button to its own card, not to the whole row', () => {
    // `.pf-music__coll-actions--rail` is `position: absolute; right: 8px`. With
    // no positioned ancestor it resolved against `.pf-music__rail-viewport` and
    // landed in the corner of the entire row, ~900px from its album. The
    // scroll-driven `scale` masks this by establishing a containing block, but
    // only where that animation runs — Firefox and reduced-motion users would
    // still get the stray button. So the card states it outright.
    const at = css.indexOf('.pf-music__rail .pf-music__rec {');
    const body = css.slice(at, css.indexOf('}', at));

    expect(body).toContain('position: relative');
  });

  it('puts the controls on the artwork, where they cannot land on the text', () => {
    // They used to sit below the subtitle, pinned bottom-right, which put them
    // on top of the artist line the moment the card lost its tray. On the cover
    // they have somewhere to belong — same place a song card's play disc goes.
    const { container } = renderRow({ items: [album] });

    const art = container.querySelector('.pf-music__rec--coll .pf-music__rec-art');
    expect(art?.querySelector('.pf-music__coll-actions--rail')).not.toBeNull();
    expect(art?.querySelector('.pf-music__rec-kind')).not.toBeNull();
  });

  it('leaves a collection card the same height as the songs beside it', () => {
    // Below the cover a collection must hold what a song holds: title and
    // subtitle, nothing else. The kind tag moved onto the artwork precisely
    // because a third line made this one card taller than the whole rail.
    const { container } = renderRow({ items: [album] });
    const card = container.querySelector('.pf-music__rec--coll') as HTMLElement;

    const belowCover = Array.from(card.children).filter(
      (el) => !el.classList.contains('pf-music__rec-art'),
    );
    expect(belowCover.map((el) => el.className)).toEqual([
      'pf-music__rec-title',
      'pf-music__rec-sub',
    ]);
  });

  it('reveals the controls without hover on coarse pointers', () => {
    // Same lesson the play disc already cost this codebase once: a control
    // revealed by :hover does not exist on a phone.
    const rule = ruleInMedia(css, COARSE_POINTER, '.pf-music__coll-actions--rail');

    expect(rule, 'no coarse-pointer rule makes the collection controls visible').not.toBeNull();
    expect(rule?.declarations).toMatch(/opacity:\s*1\s*;/);
  });
});
