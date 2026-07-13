import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerScreen } from './PlayerScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getPlaybackInfo } from '../../api/jellyfin';
import { ApiError } from '../../lib/http/errors';
import { clearSubtitlePreference } from '../../lib/domain/playerPrefs';

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
    clearSubtitlePreference();
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

describe('PlayerScreen — audio/subtitle track menus (player spec §8)', () => {
  const mediaSources = {
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
  };

  // Two "primary" subtitle languages (Español, Inglés) + two "others"
  // (Francés, Alemán) so the "Más subtítulos" fold has something to fold.
  const mediaStreams = [
    { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
    { Index: 2, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
    { Index: 3, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English', IsDefault: false },
    { Index: 4, Type: 'Subtitle', Language: 'fre', DisplayTitle: 'Français', IsDefault: false },
    { Index: 5, Type: 'Subtitle', Language: 'deu', DisplayTitle: 'Deutsch', IsDefault: false },
  ];

  beforeEach(() => {
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-tracks',
      Name: 'Track menu movie',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: mediaStreams,
    } as never);
  });

  it('renders the audio and subtitle track buttons once tracks load', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    expect(await screen.findByRole('button', { name: 'Audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subtítulos' })).toBeInTheDocument();
  });

  it('opening the subtitle menu lists "Ninguno", the primary languages, and folds the rest behind "Más subtítulos"', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));

    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    expect(within(dialog).getByRole('button', { name: 'Ninguno' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Español' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Inglés' })).toBeInTheDocument();

    // Folded: French/German aren't shown until "Más subtítulos" is opened.
    expect(within(dialog).queryByText('Francés')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Alemán')).not.toBeInTheDocument();
    const expandButton = within(dialog).getByRole('button', { name: /Más subtítulos/ });
    expect(expandButton).toHaveTextContent('Más subtítulos (2)');

    fireEvent.click(expandButton);
    expect(within(dialog).getByRole('button', { name: 'Francés' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Alemán' })).toBeInTheDocument();
  });

  it('selecting a subtitle option closes the menu', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Español' }));

    expect(screen.queryByRole('dialog', { name: 'Subtítulos' })).not.toBeInTheDocument();
  });

  it('opening the audio menu lists the enumerated audio tracks', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Audio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Audio' });
    expect(within(dialog).getByRole('button', { name: 'Inglés' })).toBeInTheDocument();
  });
});
