import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MusicResultRow } from './MusicResultRow';
import type { MusicSearchResult } from '../../api/schemas/music';
import type { MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { setSession } from '../../lib/session/store';

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

describe('MusicResultRow play button', () => {
  it('offers to preview an idle row', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /Reproducir Chachachá sin descargar/ }));
    expect(props.onPreview).toHaveBeenCalledWith(RESULT);
  });

  it('shows Pausar once its own track is the one playing', () => {
    renderRow({ current: { itemId: 'vid-1', videoId: 'vid-1' } as MusicTrack, isPlaying: true });
    // The bug this covers: the row kept a play glyph while the bar showed pause.
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
  });

  it('pauses instead of restarting the track it is already playing', () => {
    const props = renderRow({
      current: { itemId: 'vid-1', videoId: 'vid-1' } as MusicTrack,
      isPlaying: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
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
