import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MusicResultRow } from './MusicResultRow';
import { setTrackRating } from '../../api/music';
import type { MusicSearchResult } from '../../api/schemas/music';
import type { MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { setSession } from '../../lib/session/store';

// Only the rating call is faked; the row's download plumbing keeps the real
// module so nothing else in this file changes behaviour.
vi.mock('../../api/music', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/music')>()),
  setTrackRating: vi.fn().mockResolvedValue({ videoId: 'vid-1', rating: 1 }),
  getRatings: vi.fn().mockResolvedValue({ ratings: {}, liked: [] }),
}));

const mockedSetTrackRating = vi.mocked(setTrackRating);

const RESULT = {
  videoId: 'vid-1',
  title: 'Chachachá',
  artist: 'Jósean Log',
  artists: ['Jósean Log'],
  album: 'Háblate de Mí',
  durationSeconds: 216,
  thumbnailUrl: null,
  source: 'ytmusic',
  genre: null,
  downloaded: false,
  jellyfinItemId: null,
} as MusicSearchResult;

function renderRow(over: Partial<Parameters<typeof MusicResultRow>[0]> = {}) {
  const props = {
    result: RESULT,
    state: undefined,
    itemId: null,
    onDownload: vi.fn(),
    onPlay: vi.fn(),
    onEnqueue: vi.fn(),
    onEnqueuePreview: vi.fn(),
    onPreview: vi.fn(),
    current: null as MusicTrack | null,
    isPlaying: false,
    onToggle: vi.fn(),
    ...over,
  };
  // The row embeds MusicRowMenu, which talks to react-query.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ul>
          <MusicResultRow {...props} />
        </ul>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return props;
}

describe('MusicResultRow thumb-up', () => {
  it('sends the artist and cover with the vote, so "Tus me gusta" shows a track and not an id', async () => {
    // Reproduced on the running app: "Tus me gusta" rendered `fQL9ub1x5Kw`
    // with "Desconocido" underneath and no artwork. The worker stores exactly
    // what the vote carries and never resolves a bare videoId afterwards
    // (`user_liked` falls back to `row.get("title") or vid`), so a vote sent
    // without metadata is unrenderable for good.
    //
    // This row is the ONLY place in the app where a thumb can be cast from a
    // list — the feed rows have no rating control at all — so whatever it
    // omits here is what ends up stored.
    mockedSetTrackRating.mockClear();
    const withArt = { ...RESULT, thumbnailUrl: 'https://img.example/1.jpg' } as MusicSearchResult;
    renderRow({ result: withArt });

    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para Chachachá' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Me gusta Chachachá' }));

    // The vote goes out through a react-query mutation, so it lands a tick
    // after the click — asserting straight away would fail on timing and hide
    // whether the metadata is there at all.
    await waitFor(() =>
      expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', 1, {
        title: 'Chachachá',
        artist: 'Jósean Log',
        thumbnailUrl: 'https://img.example/1.jpg',
      }),
    );
  });
});

describe('MusicResultRow play control', () => {
  it('offers to preview an idle row', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /Reproducir Chachachá sin descargar/ }));
    expect(props.onPreview).toHaveBeenCalledWith(RESULT);
  });

  it('puts the control on the cover instead of beside it', () => {
    // The owner asked for the artwork itself to play the track ("al dar click
    // en la caratula se dara play o pausa automaticamente"), so the row must
    // not carry a separate play button any more.
    renderRow();

    const play = screen.getByRole('button', { name: /Reproducir Chachachá sin descargar/ });
    expect(play.className).toContain('pf-music__art-btn');
    expect(play.closest('.pf-music__art')).not.toBeNull();
    expect(document.querySelector('.pf-music__play-icon')).toBeNull();
  });

  it('shows no ▶/⏸ marker on a row that is not the loaded track', () => {
    // A glyph on every row said nothing about which one was making noise.
    renderRow({ current: { itemId: 'vid-other', videoId: 'vid-other' } as MusicTrack });

    expect(document.querySelector('.pf-music__art-state')).toBeNull();
  });

  it('marks the loaded track with a glyph that is status, not a second button', () => {
    renderRow({ current: { itemId: 'vid-1', videoId: 'vid-1' } as MusicTrack, isPlaying: true });

    const marker = document.querySelector('.pf-music__art-state') as HTMLElement;
    expect(marker).not.toBeNull();
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    // One control on the artwork, not two: the marker sits inside the cover's
    // own button rather than beside it.
    expect(marker.closest('button')?.className).toContain('pf-music__art-btn');
    expect(document.querySelectorAll('.pf-music__art button')).toHaveLength(1);
  });

  it('shows Pausar once its own track is the one playing', () => {
    renderRow({ current: { itemId: 'vid-1', videoId: 'vid-1' } as MusicTrack, isPlaying: true });
    // The bug this covers: the row kept a play glyph while the bar showed pause.
    expect(screen.getByRole('button', { name: 'Pausar Chachachá' })).toBeInTheDocument();
  });

  it('pauses instead of restarting the track it is already playing', () => {
    const props = renderRow({
      current: { itemId: 'vid-1', videoId: 'vid-1' } as MusicTrack,
      isPlaying: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pausar Chachachá' }));
    expect(props.onToggle).toHaveBeenCalled();
    expect(props.onPreview).not.toHaveBeenCalled();
  });

  it('stays marked as the loaded track while paused, so resuming is one tap', () => {
    const props = renderRow({
      current: { itemId: 'vid-1', videoId: 'vid-1' } as MusicTrack,
      isPlaying: false,
    });
    fireEvent.click(screen.getByRole('button', { name: /Reproducir Chachachá/ }));
    expect(props.onToggle).toHaveBeenCalled();
  });

  it('leaves other rows alone', () => {
    const props = renderRow({
      current: { itemId: 'vid-other', videoId: 'vid-other' } as MusicTrack,
      isPlaying: true,
    });
    fireEvent.click(screen.getByRole('button', { name: /Reproducir Chachachá sin descargar/ }));
    expect(props.onPreview).toHaveBeenCalled();
    expect(props.onToggle).not.toHaveBeenCalled();
  });
});
