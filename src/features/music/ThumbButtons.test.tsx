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

describe('ThumbButtons', () => {
  // A stand-in server: the mutation writes here and the refetch reads it back,
  // so an optimistic update that gets reverted by a stale read would be caught.
  let stored: Record<string, number> = {};

  beforeEach(() => {
    stored = {};
    mockedGetRatings.mockImplementation(async () => ({ ...stored }));
    mockedSetTrackRating.mockImplementation(async (videoId, rating) => {
      if (rating === 0) delete stored[videoId];
      else stored[videoId] = rating;
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
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', -1));
  });

  it('casts a thumb up', async () => {
    renderThumbs();
    fireEvent.click(screen.getByRole('button', { name: /^Me gusta/ }));
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', 1));
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
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', 0));
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
    await waitFor(() => expect(mockedSetTrackRating).toHaveBeenCalledWith('vid-1', -1));
    expect(screen.getByRole('button', { name: /^Me gusta/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
