import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NowPlayingBar } from './NowPlayingBar';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getRatings, setTrackRating } from '../../api/music';

// Only the new full-player thumbs tests below exercise ThumbButtons (the
// default `tracks`/`unmatchedTracks` fixtures have no videoId, so it never
// mounts elsewhere in this file) — mocked so those assertions don't depend on
// a real network round-trip.
vi.mock('../../api/music', () => ({
  getRatings: vi.fn(),
  setTrackRating: vi.fn(),
}));
const mockedGetRatings = vi.mocked(getRatings);
const mockedSetTrackRating = vi.mocked(setTrackRating);

// Slice 2 NowPlayingBar render test: the transport controls are present as
// native focusable buttons (TV-remote reachable), and moving the seek bar
// drives `seek` (the position reflected back through the provider).
//
// Mobile pattern (this batch): a compact bar that expands to a full-screen
// player. `matchMedia` is driven per-test to force the compact layout.

const tracks: MusicTrack[] = [
  { itemId: 'a', title: 'Track A', artist: 'Artist A', coverUrl: null, artistId: 'art-a' },
  { itemId: 'b', title: 'Track B', artist: 'Artist B', coverUrl: null },
];

// A library track with no videoId (never matched to a YouTube hit) — the
// same "no rating possible" guard the desktop bar already applies.
const unmatchedTracks: MusicTrack[] = [
  { itemId: 'u', title: 'Unmatched Track', artist: 'Artist U', coverUrl: null },
];

const ratedTracks: MusicTrack[] = [
  { itemId: 'r', title: 'Rated Track', artist: 'Artist R', coverUrl: null, videoId: 'yt-r' },
];

// Stand-in server for the ratings mutation (mirrors ThumbButtons.test.tsx).
let ratingsStore: Record<string, number> = {};
beforeEach(() => {
  ratingsStore = {};
  // The envelope carries the liked list alongside the votes; a fake still
  // returning the old bare map would leave every thumb permanently unfilled.
  mockedGetRatings.mockImplementation(async () => ({
    ratings: { ...ratingsStore },
    liked: Object.entries(ratingsStore)
      .filter(([, vote]) => vote === 1)
      .map(([videoId]) => ({
        type: 'song' as const,
        videoId,
        title: videoId,
        artist: null,
        artists: [],
        album: null,
        durationSeconds: null,
        thumbnailUrl: null,
        source: 'ytmusic' as const,
      })),
  }));
  mockedSetTrackRating.mockImplementation(async (videoId, rating) => {
    if (rating === 0) delete ratingsStore[videoId];
    else ratingsStore[videoId] = rating;
    return { videoId, rating };
  });
});
afterEach(() => {
  mockedGetRatings.mockReset();
  mockedSetTrackRating.mockReset();
  // A test that fails mid-fake-timer would otherwise leave fake timers active
  // for the next test's `waitFor` (which needs real timers to resolve).
  vi.useRealTimers();
});

// Force the desktop (false) or compact/mobile (true) layout by making
// `matchMedia('(max-width: 899px)')` report `matches`. Other queries fall back
// to false.
function setCompactViewport(isCompact: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: isCompact && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Seed({ seedTracks = tracks }: { seedTracks?: MusicTrack[] }) {
  const { playNow } = useMusicPlayer();
  useEffect(() => {
    playNow(seedTracks, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function Probe() {
  const { position } = useMusicPlayer();
  return <div data-testid="position">{Math.round(position)}</div>;
}

function renderBar(seedTracks?: MusicTrack[], path = '/musica') {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* The bar is a music-half surface, so tests exercise it on a /musica
          route (on the cine side it intentionally renders null). */}
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <MusicPlayerProvider>
            <Seed seedTracks={seedTracks} />
            <NowPlayingBar />
            <Probe />
          </MusicPlayerProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NowPlayingBar — desktop layout', () => {
  beforeEach(() => setCompactViewport(false));
  afterEach(() => clearSession());

  it('renders the current track and the transport controls', () => {
    renderBar();
    expect(screen.getByText('Track A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aleatorio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cola' })).toBeInTheDocument();
    // Playing after playNow, so the toggle offers "Pausar".
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
  });

  it('seeks when the progress bar is moved', () => {
    renderBar();
    // Give the track a duration so the seek range has a usable maximum.
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 200 });
    fireEvent.durationChange(audio);

    const seekbar = screen.getByLabelText('Buscar en la pista');
    fireEvent.change(seekbar, { target: { value: '42' } });

    expect(screen.getByTestId('position')).toHaveTextContent('42');
  });

  it('opens the queue drawer from the queue button', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Cola' }));
    expect(screen.getByRole('dialog', { name: 'Cola de reproducción' })).toBeInTheDocument();
    // Both queued tracks are listed.
    expect(screen.getByRole('button', { name: 'Reproducir Track B' })).toBeInTheDocument();
  });

  it('keeps the queue reachable on desktop (never display:none)', () => {
    renderBar();
    const queueBtn = screen.getByRole('button', { name: 'Cola' });
    // The old mobile rule hid the whole `__extra` group; regression guard.
    expect(queueBtn.closest('.pf-nowplaying__extra')).not.toBeNull();
    expect(getComputedStyle(queueBtn).display).not.toBe('none');
  });

  // A Jam is the music half too (`lib/domain/lastSection.ts` has said so since
  // it was written), so local playback keeps its controls on the room screen
  // instead of the bar vanishing the moment you go to manage a room.
  it('keeps the local transport on /jam', () => {
    renderBar(undefined, '/jam');
    expect(screen.getByRole('region', { name: 'Reproduciendo ahora' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
  });

  it('still renders nothing on the cine side', () => {
    renderBar(undefined, '/downloads');
    expect(screen.queryByRole('region', { name: 'Reproduciendo ahora' })).not.toBeInTheDocument();
  });

  // Reliability change: buffering is state nobody can see without a UI cue.
  it('marks the toggle button aria-busy and pulsing once a stall settles', () => {
    vi.useFakeTimers();
    renderBar();
    const toggle = screen.getByRole('button', { name: 'Pausar' });
    expect(toggle).not.toHaveAttribute('aria-busy', 'true');
    expect(toggle).not.toHaveClass('pf-nowplaying__toggle--buffering');

    const audio = document.querySelector('audio') as HTMLAudioElement;
    fireEvent.waiting(audio);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(toggle).toHaveClass('pf-nowplaying__toggle--buffering');
    vi.useRealTimers();
  });
});

describe('NowPlayingBar — compact mobile layout', () => {
  beforeEach(() => setCompactViewport(true));
  afterEach(() => clearSession());

  it('stays visible when a track is loaded but PAUSED (not gated on isPlaying)', () => {
    renderBar();
    // A track is loaded and playing after the Seed.
    const toggle = screen.getByRole('button', { name: 'Pausar' });
    // Pause it — the mini-player must NOT disappear when playback stops.
    fireEvent.click(toggle);
    // Compact bar is still mounted: the expand target and a "Reproducir" (paused)
    // toggle remain, proving the render condition is "track loaded", not "playing".
    expect(screen.getByRole('button', { name: 'Abrir reproductor: Track A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeInTheDocument();
    expect(screen.getByText('Track A')).toBeInTheDocument();
  });

  it('renders a compact bar with play/pause and an expand button, no cramped transport', () => {
    renderBar();
    // Compact bar shows play/pause (Pausar, since playing) and the expand target.
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Abrir reproductor: Track A' }),
    ).toBeInTheDocument();
    // The compact bar has prev/next for quick skipping...
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeInTheDocument();
    // ...but the cramped cluster (shuffle/repeat/volume/seek) stays in the full player.
    expect(screen.queryByRole('button', { name: 'Aleatorio' })).not.toBeInTheDocument();
    // No full-screen player until expanded.
    expect(screen.queryByRole('dialog', { name: 'Reproduciendo' })).not.toBeInTheDocument();
  });

  it('expands to a full-screen player with all controls and a queue button', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));

    const dialog = screen.getByRole('dialog', { name: 'Reproduciendo' });
    expect(dialog).toBeInTheDocument();
    // Full transport, volume, seek and collapse are all present inside the
    // full-screen player (scoped: the compact bar stays mounted underneath).
    const inDialog = within(dialog);
    expect(inDialog.getByRole('button', { name: 'Contraer reproductor' })).toBeInTheDocument();
    expect(inDialog.getByRole('button', { name: 'Anterior' })).toBeInTheDocument();
    expect(inDialog.getByRole('button', { name: 'Siguiente' })).toBeInTheDocument();
    expect(inDialog.getByRole('button', { name: 'Aleatorio' })).toBeInTheDocument();
    expect(inDialog.getByRole('button', { name: 'Silenciar' })).toBeInTheDocument();
    expect(inDialog.getByLabelText('Buscar en la pista')).toBeInTheDocument();
    expect(inDialog.getByLabelText('Volumen')).toBeInTheDocument();
    expect(inDialog.getByRole('button', { name: 'Cola' })).toBeInTheDocument();
  });

  it('makes the artist tappable when an artistId is present', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
    const artistLink = screen.getByRole('link', { name: 'Ir al artista Artist A' });
    expect(artistLink).toHaveAttribute('href', '/musica/artist/art-a');
  });

  it('opens the reachable queue from the expanded player', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
    // Scoped to the full player: the compact bar behind it now carries its own
    // queue button (the mobile bar no longer hides the queue behind an expand),
    // so a flat query would match two buttons named "Cola". A real screen
    // reader never sees both — the full player is `aria-modal`.
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Reproduciendo' })).getByRole('button', {
        name: 'Cola',
      }),
    );
    const drawer = screen.getByRole('dialog', { name: 'Cola de reproducción' });
    expect(drawer).toBeInTheDocument();
    // Queue is a real drawer, not hidden.
    expect(getComputedStyle(drawer).display).not.toBe('none');
    expect(screen.getByRole('button', { name: 'Reproducir Track B' })).toBeInTheDocument();
  });

  it('collapses the full-screen player with the down-chevron', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Contraer reproductor' }));
    expect(screen.queryByRole('dialog', { name: 'Reproduciendo' })).not.toBeInTheDocument();
    // Back to the compact bar.
    expect(screen.getByRole('button', { name: 'Abrir reproductor: Track A' })).toBeInTheDocument();
  });

  // Shared dismissal via OverlayShell (design D: `sdd/mobile-music-overhaul`).
  // FullPlayer is full-bleed and has no "outside" concept, so it opts out of
  // backdrop-click dismissal - only Escape and its own chevron close it.
  describe('full player — shared dismissal (OverlayShell)', () => {
    afterEach(() => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
    });

    it('collapses on Escape', () => {
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Reproduciendo' })).not.toBeInTheDocument();
    });

    it('clicking inside the full player does not collapse it (no backdrop-click dismiss)', () => {
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
      const dialog = screen.getByRole('dialog', { name: 'Reproduciendo' });

      fireEvent.click(dialog);
      expect(screen.getByRole('dialog', { name: 'Reproduciendo' })).toBeInTheDocument();
    });

    it('locks body scroll while expanded and releases it on collapse', () => {
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
      expect(document.body.style.position).toBe('fixed');

      fireEvent.click(screen.getByRole('button', { name: 'Contraer reproductor' }));
      expect(document.body.style.position).toBe('');
    });

    it('returns focus to the expand trigger once collapsed', () => {
      renderBar();
      const trigger = screen.getByRole('button', { name: 'Abrir reproductor: Track A' });
      trigger.focus();
      fireEvent.click(trigger);

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(trigger).toHaveFocus();
    });

    // Opening the queue from inside the full player collapses it first
    // (`onOpenQueue` calls `setExpanded(false)` then `setQueueOpen(true)` -
    // they are sibling overlays, never simultaneously open in this app), so
    // there is no FullPlayer+QueueDrawer nested-stack scenario to cover here.
    // `OverlayShell.test.tsx` already covers nested-overlay Escape ownership
    // generically (only the topmost overlay reacts).
    it('the full player is gone once its own queue button hands off to the queue drawer', () => {
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Track A' }));
      // Its OWN queue button — the compact bar behind it has one too now.
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Reproduciendo' })).getByRole('button', {
          name: 'Cola',
        }),
      );

      expect(screen.getByRole('dialog', { name: 'Cola de reproducción' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Reproduciendo' })).not.toBeInTheDocument();
    });
  });

  // jsdom loads no CSS, so a control's real size is invisible to every other
  // test in this file — which is how the compact transport got shaved from
  // 38px to 34px without a single red test. These read the stylesheet, the
  // same trick `src/test/cssRules.ts` uses for `opacity: 0`.
  describe('touch targets (WCAG 2.5.5)', () => {
    const css = readFileSync(resolve(__dirname, 'NowPlayingBar.css'), 'utf8');

    /** The declarations of the top-level rule whose selector is exactly this. */
    function declarationsFor(selector: string): string {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, `no rule found for \`${selector}\``).toBeGreaterThan(-1);
      const open = css.indexOf('{', at);
      return css.slice(open + 1, css.indexOf('}', open));
    }

    it.each([
      '.pf-nowplaying--compact .pf-nowplaying__btn',
      '.pf-nowplaying__toggle--compact',
      '.pf-nowplaying__art--compact',
    ])('gives %s a 44px box', (selector) => {
      const declarations = declarationsFor(selector);
      expect(declarations).toMatch(/width:\s*44px/);
      expect(declarations).toMatch(/height:\s*44px/);
    });

    it('leaves real separation between prev, play and next', () => {
      const declarations = declarationsFor(
        '.pf-nowplaying--compact .pf-nowplaying__compact-controls',
      );
      const gap = /gap:\s*([\d.]+)rem/.exec(declarations);
      expect(gap).not.toBeNull();
      // 2px was the measured distance between "Anterior" and "Pausar", which
      // on a thumb is no distance at all.
      expect(Number(gap?.[1]) * 16).toBeGreaterThanOrEqual(8);
    });

    it('sizes the compact grid row to the 44px controls it holds', () => {
      expect(declarationsFor('.pf-nowplaying--compact')).toMatch(
        /grid-template-rows:\s*44px auto/,
      );
    });
  });

  // Reliability change: thumbs up/down reachable from the mobile full-screen
  // player too, mirroring the desktop bar's `current.videoId` guard.
  describe('full player — thumbs (music-track-feedback)', () => {
    it('renders ThumbButtons as the leading item of the bottom row when videoId is defined', async () => {
      renderBar(ratedTracks);
      fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Rated Track' }));
      const dialog = screen.getByRole('dialog', { name: 'Reproduciendo' });
      const inDialog = within(dialog);

      const thumbUp = inDialog.getByRole('button', { name: /^Me gusta/ });
      expect(thumbUp).toBeInTheDocument();
      const wrapper = thumbUp.closest('.pf-thumbs');
      expect(wrapper).toHaveClass('pf-thumbs--full');
      // Leading item of .pf-fullplayer__bottom: the volume control comes after it.
      const bottom = dialog.querySelector('.pf-fullplayer__bottom');
      expect(bottom?.firstElementChild).toContainElement(wrapper as HTMLElement);
    });

    it('does not render for a library track with no videoId (unmatched guard)', () => {
      renderBar(unmatchedTracks);
      fireEvent.click(
        screen.getByRole('button', { name: 'Abrir reproductor: Unmatched Track' }),
      );
      const dialog = screen.getByRole('dialog', { name: 'Reproduciendo' });
      expect(within(dialog).queryByText(/Me gusta/)).not.toBeInTheDocument();
    });

    it('a rating click reaches the same rate store as the bar/menu variants', async () => {
      renderBar(ratedTracks);
      fireEvent.click(screen.getByRole('button', { name: 'Abrir reproductor: Rated Track' }));
      const dialog = screen.getByRole('dialog', { name: 'Reproduciendo' });
      fireEvent.click(within(dialog).getByRole('button', { name: /^Me gusta/ }));
      // useRatings persists via localStorage in this app's real store — the
      // pressed state flipping proves the click reached the shared hook.
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: /^Me gusta/ })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
    });
  });
});
