import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerScreen } from './PlayerScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getPlaybackInfo } from '../../api/jellyfin';
import { ApiError } from '../../lib/http/errors';

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

// Same controllable fake as VideoSurface.test.tsx - jsdom has no
// MediaSource Extensions, so a real hls.js would never actually attach.
// Built inside `vi.hoisted` because `vi.mock` factories are hoisted above
// every other top-level statement (referencing an outer `class` declared
// later in the file hits a TDZ error at mock-eval time).
const hoisted = vi.hoisted(() => {
  const instances: InstanceType<typeof FakeHls>[] = [];

  class FakeHls {
    static Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' } as const;
    static isSupported() {
      return true;
    }

    handlers: Record<string, (...args: unknown[]) => void> = {};
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();

    constructor() {
      instances.push(this);
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = cb;
    }
  }

  return { instances, FakeHls };
});

const hlsInstances = hoisted.instances;

vi.mock('hls.js', () => ({ default: hoisted.FakeHls }));

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

describe('PlayerScreen (player spec: stream resolution + honest error messages)', () => {
  afterEach(() => {
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    hlsInstances.length = 0;
    vi.clearAllMocks();
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
    expect(hlsInstances).toHaveLength(0);
  });

  it('Transcode-only (e.g. HEVC): loads the HLS TranscodingUrl via hls.js instead of refusing playback', async () => {
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

    await screen.findByTestId('pf-video');
    expect(hlsInstances).toHaveLength(1);
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith('/jellyfin/videos/item-1/master.m3u8');
    expect(screen.queryByText(/no es compatible/i)).not.toBeInTheDocument();
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

  it('a real 401 on the PlaybackInfo fetch shows a session/auth message, not a generic one', async () => {
    mockedGetPlaybackInfo.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-4',
      Name: 'Any movie',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
    } as never);

    renderPlayer('jf-item-4');

    await screen.findByText(/sesión expiró/i);
    expect(screen.queryByTestId('pf-video')).not.toBeInTheDocument();
  });

  it('a network/PlaybackInfo failure that is NOT a 401 shows a load-failure message, not the auth one', async () => {
    mockedGetPlaybackInfo.mockRejectedValue(new Error('boom'));
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-5',
      Name: 'Any movie',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
    } as never);

    renderPlayer('jf-item-5');

    await screen.findByText(/no se pudo cargar la información de reproducción/i);
    expect(screen.queryByText(/sesión expiró/i)).not.toBeInTheDocument();
  });
});
