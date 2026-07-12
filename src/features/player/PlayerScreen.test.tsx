import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerScreen } from './PlayerScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getPlaybackInfo } from '../../api/jellyfin';

vi.mock('../../api/jellyfin', async () => {
  const actual = await vi.importActual<typeof import('../../api/jellyfin')>('../../api/jellyfin');
  return {
    ...actual,
    getPlaybackInfo: vi.fn(),
    getItem: vi.fn(),
    reportPlaying: vi.fn().mockResolvedValue(undefined),
    reportProgress: vi.fn().mockResolvedValue(undefined),
    reportStopped: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedGetPlaybackInfo = vi.mocked(getPlaybackInfo);
const mockedGetItem = vi.mocked(getItem);

function TestRouteTree() {
  return useRoutes([{ path: '/player/:id', element: <PlayerScreen /> }]);
}

function renderPlayer(itemId = 'jf-item-1') {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <MemoryRouter initialEntries={[`/player/${itemId}`]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TestRouteTree />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PlayerScreen (player spec: "DirectPlay-only stream resolution")', () => {
  afterEach(() => {
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
  });

  it('DirectPlay: sets the <video> src to the resolved api_key-authenticated URL', async () => {
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mp4',
          TranscodingUrl: null,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          MediaStreams: [],
        },
      ],
      PlaySessionId: 'sess-1',
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-1',
      Name: 'Night of the Living Dead',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
    } as never);

    renderPlayer('jf-item-1');

    const video = await screen.findByTestId('pf-video');
    expect(video).toHaveAttribute(
      'src',
      '/jellyfin/Videos/jf-item-1/stream.mp4?static=true&mediaSourceId=ms-1&api_key=tok-1',
    );
  });

  it('Transcode-only: shows the explicit not-supported state and never renders a <video>', async () => {
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mkv',
          TranscodingUrl: '/videos/item-1/master.m3u8',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          MediaStreams: [],
        },
      ],
      PlaySessionId: 'sess-1',
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-2',
      Name: 'The Matrix',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
    } as never);

    renderPlayer('jf-item-2');

    await screen.findByText(/no es compatible en esta versi.n/i);
    expect(screen.queryByTestId('pf-video')).not.toBeInTheDocument();
  });

  it('resolves the resume position from UserData.PlaybackPositionTicks into seconds', async () => {
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mp4',
          TranscodingUrl: null,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          MediaStreams: [],
        },
      ],
      PlaySessionId: 'sess-1',
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-3',
      Name: 'Resumable movie',
      // 100_000_000 ticks = 10s.
      UserData: { PlaybackPositionTicks: 100_000_000, PlayCount: 1, Played: false, IsFavorite: false },
    } as never);

    renderPlayer('jf-item-3');

    const video = (await screen.findByTestId('pf-video')) as HTMLVideoElement;
    // The resume seek itself is exercised by VideoSurface's own tests; here
    // we only confirm PlayerScreen wires the resolved resume seconds through
    // by firing the ready event and checking the guard actually applied it.
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(10);
  });
});
