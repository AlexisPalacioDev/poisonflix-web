import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getRatings, setTrackRating } from '../../api/music';
import { ThumbButtons } from './ThumbButtons';

vi.mock('../../api/music', () => ({
  getRatings: vi.fn(),
  setTrackRating: vi.fn(),
}));

const mockedGetRatings = vi.mocked(getRatings);
const mockedSetTrackRating = vi.mocked(setTrackRating);

function renderThumbs() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThumbButtons videoId="vid-1" title="Chachachá" />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// What every vote carries: the row already knows these, and sending them is
// what lets "Tus me gusta" list a track instead of a bare videoId.
const META = { title: 'Chachachá', artist: null, thumbnailUrl: null };

describe('ThumbButtons', () => {
  // A stand-in server: the mutation writes here and the refetch reads it back,
  // so an optimistic update that gets reverted by a stale read would be caught.
  // It answers with the real envelope — votes AND the renderable liked list —
  // because a fake that still returned the old bare map would let a regression
  // in that shape pass unnoticed.
  let stored: Record<string, number> = {};
  let likedMeta: Record<string, { title?: string | null; artist?: string | null }> = {};

  beforeEach(() => {
    stored = {};
    likedMeta = {};
    mockedGetRatings.mockImplementation(async () => ({
      ratings: { ...stored },
      liked: Object.entries(stored)
        .filter(([, vote]) => vote === 1)
        .map(([videoId]) => ({
          type: 'song' as const,
          videoId,
          title: likedMeta[videoId]?.title ?? videoId,
          artist: likedMeta[videoId]?.artist ?? null,
          artists: [],
          album: null,
          durationSeconds: null,
          thumbnailUrl: null,
          source: 'ytmusic' as const,
        })),
    }));
    mockedSetTrackRating.mockImplementation(async (videoId, rating, meta) => {
      if (rating === 0) delete stored[videoId];
      else stored[videoId] = rating;
      if (meta) likedMeta[videoId] = { title: meta.title, artist: meta.artist };
      return { videoId, rating };
    });
  });

  afterEach(() => {
    clearSession();
    mockedGetRatings.mockReset();
    mockedSetTrackRating.mockReset();
  });

  it('casts a thumb down', async () => {
    renderThumbs();
    fireEvent.click(screen.getByRole('button', { name: /No me gusta/ }));
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', -1, META));
  });

  it('casts a thumb up', async () => {
    renderThumbs();
    fireEvent.click(screen.getByRole('button', { name: /^Me gusta/ }));
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', 1, META));
  });

  it('shows the vote this user already holds', async () => {
    stored = { 'vid-1': -1 };
    renderThumbs();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /No me gusta/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('clears the vote when the held thumb is pressed again — a mis-tap is undoable', async () => {
    stored = { 'vid-1': 1 };
    renderThumbs();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Me gusta/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Me gusta/ }));
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', 0, META));
  });

  it('switches sides rather than holding both thumbs at once', async () => {
    stored = { 'vid-1': 1 };
    renderThumbs();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Me gusta/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /No me gusta/ }));
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', -1, META));
    expect(screen.getByRole('button', { name: /^Me gusta/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  // Reliability change: a third variant for the mobile full-screen player,
  // icon-only like `bar` (labels already gate on `variant === 'menu'`) but
  // styled at a 44x44 tap target of its own — see thumbs.css.
  describe("'full' variant (mobile full-screen player)", () => {
    function renderThumbsFull() {
      setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ThumbButtons videoId="vid-1" title="Chachachá" variant="full" />
          </AuthProvider>
        </QueryClientProvider>,
      );
    }

    it('renders both thumb-up and thumb-down controls', async () => {
      renderThumbsFull();
      await waitFor(() => expect(mockedGetRatings).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: /^Me gusta/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /No me gusta/ })).toBeInTheDocument();
    });

    it('carries a pf-thumbs--full wrapper class distinct from menu/bar', async () => {
      renderThumbsFull();
      await waitFor(() => expect(mockedGetRatings).toHaveBeenCalled());
      const wrapper = screen.getByRole('button', { name: /^Me gusta/ }).closest('.pf-thumbs');
      expect(wrapper).toHaveClass('pf-thumbs--full');
      expect(wrapper).not.toHaveClass('pf-thumbs--menu');
      expect(wrapper).not.toHaveClass('pf-thumbs--bar');
    });
  });
});
