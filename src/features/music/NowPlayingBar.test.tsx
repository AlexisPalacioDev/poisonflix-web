import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NowPlayingBar } from './NowPlayingBar';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';

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

function Seed() {
  const { playNow } = useMusicPlayer();
  useEffect(() => {
    playNow(tracks, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function Probe() {
  const { position } = useMusicPlayer();
  return <div data-testid="position">{Math.round(position)}</div>;
}

function renderBar() {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* The bar is a Música-section surface, so tests exercise it on a /musica
          route (on the cine side it intentionally renders null). */}
      <MemoryRouter initialEntries={['/musica']}>
        <AuthProvider>
          <MusicPlayerProvider>
            <Seed />
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
    fireEvent.click(screen.getByRole('button', { name: 'Cola' }));
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
});
