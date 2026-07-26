import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MusicCollectionCard } from './MusicCollectionCard';
import type { MusicAlbumResult, MusicPlaylistResult } from '../../api/schemas/music';
import { AuthProvider } from '../../auth/AuthContext';
import { setSession } from '../../lib/session/store';

const ALBUM = {
  type: 'album',
  browseId: 'MPREb_1',
  title: 'BANANA CHACHA',
  artist: 'MOMOLAND',
  year: 2019,
  trackCount: 2,
  thumbnailUrl: null,
} as MusicAlbumResult;

const PLAYLIST = {
  type: 'playlist',
  playlistId: 'PL_1',
  title: 'Best Cha Cha Cha Songs',
  author: 'salsamalsa',
  trackCount: 222,
  thumbnailUrl: null,
} as MusicPlaylistResult;

function renderCard(props: Partial<Parameters<typeof MusicCollectionCard>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ul>
          <MusicCollectionCard item={ALBUM} {...props} />
        </ul>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('MusicCollectionCard', () => {
  it('keeps only the download button when no play handlers are wired', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /Descargar álbum/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reproducir álbum/ })).not.toBeInTheDocument();
  });

  it('plays the collection by its browseId', async () => {
    const onPlay = vi.fn().mockResolvedValue(undefined);
    renderCard({ onPlay });
    fireEvent.click(screen.getByRole('button', { name: /Reproducir álbum/ }));
    await waitFor(() => expect(onPlay).toHaveBeenCalledWith({ browseId: 'MPREb_1' }));
  });

  it('queues a playlist by its playlistId', async () => {
    const onEnqueue = vi.fn().mockResolvedValue(undefined);
    renderCard({ item: PLAYLIST, onEnqueue });
    fireEvent.click(screen.getByRole('button', { name: /a la cola/ }));
    await waitFor(() => expect(onEnqueue).toHaveBeenCalledWith({ playlistId: 'PL_1' }));
  });

  it('ignores a second click while the track list is still resolving', async () => {
    let release: () => void = () => {};
    const onPlay = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    renderCard({ onPlay });
    const button = screen.getByRole('button', { name: /Reproducir álbum/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onPlay).toHaveBeenCalledTimes(1);
    release();
  });

  it('says so when the track list cannot be loaded', async () => {
    const onPlay = vi.fn().mockRejectedValue(new Error('boom'));
    renderCard({ onPlay });
    fireEvent.click(screen.getByRole('button', { name: /Reproducir álbum/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar los temas.');
  });
});
