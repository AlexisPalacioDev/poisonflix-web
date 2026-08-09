import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { warmMusicTrack } from '../../api/music';

// Autoplay-radio warming: the moment a track starts playing, the *next* track
// in the queue is warmed at full depth (download + ffmpeg) — see
// `MusicPlayerProvider`'s docstring for why 'full' is only worth paying for a
// track that's almost certainly about to play. `getRadio`/autoplay itself is
// out of scope here; this queue is built by hand via `playNow`/`enqueue`.

vi.mock('../../api/music', () => ({ warmMusicTrack: vi.fn() }));
const mockedWarmMusicTrack = vi.mocked(warmMusicTrack);

// A not-yet-downloaded preview track: carries the worker's stream proxy URL,
// so it's the kind of track a full-depth warm is meant for.
const PREVIEW_A: MusicTrack = {
  itemId: 'vid-a',
  title: 'Preview A',
  artist: 'Artist A',
  coverUrl: null,
  videoId: 'vid-a',
  streamUrl: '/bff/music/stream?videoId=vid-a',
};
const PREVIEW_B: MusicTrack = {
  itemId: 'vid-b',
  title: 'Preview B',
  artist: 'Artist B',
  coverUrl: null,
  videoId: 'vid-b',
  streamUrl: '/bff/music/stream?videoId=vid-b',
};
const PREVIEW_C: MusicTrack = {
  itemId: 'vid-c',
  title: 'Preview C',
  artist: 'Artist C',
  coverUrl: null,
  videoId: 'vid-c',
  streamUrl: '/bff/music/stream?videoId=vid-c',
};
// Previews whose streamUrl embeds a real source — `previewStreamUrl` puts it
// there as a query param, so a warm for these must forward it instead of
// falling back to 'auto'.
const PREVIEW_YTMUSIC: MusicTrack = {
  itemId: 'vid-yt',
  title: 'Preview YTMusic',
  artist: 'Artist YT',
  coverUrl: null,
  videoId: 'vid-yt',
  streamUrl: '/bff/music/stream?videoId=vid-yt&source=ytmusic',
};
const PREVIEW_YOUTUBE: MusicTrack = {
  itemId: 'vid-yo',
  title: 'Preview YouTube',
  artist: 'Artist YO',
  coverUrl: null,
  videoId: 'vid-yo',
  streamUrl: '/bff/music/stream?videoId=vid-yo&source=youtube',
};
// A library track: already downloaded, plays straight from Jellyfin via
// itemId — no streamUrl, so it never goes near the worker.
const LIBRARY_TRACK: MusicTrack = {
  itemId: 'aud-1',
  title: 'Library Track',
  artist: 'Artist L',
  coverUrl: null,
};

let api: MusicPlayerContextValue;
function Capture() {
  api = useMusicPlayer();
  return null;
}

function renderProvider() {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <MusicPlayerProvider>
            <Capture />
          </MusicPlayerProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
  mockedWarmMusicTrack.mockReset();
});

describe('MusicPlayerProvider — warming the next queue track', () => {
  it('warms the next preview track at full depth once the current one is playing', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });

    // PREVIEW_B's streamUrl carries no `source` param, so 'auto' here is the
    // correct fallback — not a hardcoded default. See the two tests below for
    // the case that actually proves the source is read from the URL.
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-b', 'auto', 'full');
  });

  it('warms the next track with the source embedded in its own streamUrl (ytmusic)', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_YTMUSIC], 0);
    });

    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-yt', 'ytmusic', 'full');
  });

  it('warms the next track with the source embedded in its own streamUrl (youtube)', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_YOUTUBE], 0);
    });

    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-yo', 'youtube', 'full');
  });

  it('does not warm a next track that is already in the library', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, LIBRARY_TRACK], 0);
    });

    expect(mockedWarmMusicTrack).not.toHaveBeenCalled();
  });

  it('does nothing when the current track is the last in the queue', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A], 0);
    });

    expect(mockedWarmMusicTrack).not.toHaveBeenCalled();
  });

  it('follows the queue forward: advancing warms the new next track, one ahead at a time', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B, PREVIEW_C], 0);
    });
    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-b', 'auto', 'full');
    expect(mockedWarmMusicTrack).not.toHaveBeenCalledWith('vid-c', 'auto', 'full');

    await act(async () => {
      api.next();
    });

    expect(mockedWarmMusicTrack).toHaveBeenCalledWith('vid-c', 'auto', 'full');
  });

  it('does not warm while paused — only a track that is actually playing warms the one after it', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([PREVIEW_A, PREVIEW_B], 0);
    });
    mockedWarmMusicTrack.mockReset();

    await act(async () => {
      api.toggle(); // pause
    });

    expect(mockedWarmMusicTrack).not.toHaveBeenCalled();
  });
});
