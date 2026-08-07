import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';

// MediaSession API integration (lock-screen / background playback controls).
//
// jsdom implements neither `navigator.mediaSession` nor `MediaMetadata`, so we
// install minimal controllable stubs and assert the provider drives them:
// it publishes the current track's metadata, registers the play/pause/next/prev
// (and seek) action handlers, and mirrors playbackState.
//
// HONESTY: this proves the JS wiring only. Real lock-screen continuation and
// the on-device controls can only be confirmed on an actual iOS/Android device
// with a playing <audio> element — jsdom cannot emulate the OS media surface.

const track: MusicTrack = {
  itemId: 'a',
  title: 'Song One',
  artist: 'Artist One',
  coverUrl: '/jellyfin/Items/a/Images/Primary?tag=xyz&maxWidth=400&quality=90&api_key=tok',
};

interface MediaMetadataInit {
  title: string;
  artist: string;
  album: string;
  artwork: Array<{ src: string; sizes?: string; type?: string }>;
}

let metadata: MediaMetadataInit | null;
let playbackState: string;
let handlers: Record<string, ((details: { seekTime?: number; seekOffset?: number }) => void) | null>;
let setPositionState: ReturnType<typeof vi.fn>;

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

  metadata = null;
  playbackState = 'none';
  handlers = {};
  setPositionState = vi.fn();

  const mediaSessionStub = {
    get metadata() {
      return metadata;
    },
    set metadata(v: MediaMetadataInit | null) {
      metadata = v;
    },
    get playbackState() {
      return playbackState;
    },
    set playbackState(v: string) {
      playbackState = v;
    },
    setActionHandler(
      action: string,
      handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null,
    ) {
      handlers[action] = handler;
    },
    setPositionState,
  };

  Object.defineProperty(navigator, 'mediaSession', {
    value: mediaSessionStub,
    configurable: true,
    writable: true,
  });

  class MediaMetadataStub implements MediaMetadataInit {
    title: string;
    artist: string;
    album: string;
    artwork: MediaMetadataInit['artwork'];
    constructor(init: MediaMetadataInit) {
      this.title = init.title;
      this.artist = init.artist;
      this.album = init.album;
      this.artwork = init.artwork;
    }
  }
  (globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = MediaMetadataStub;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
  delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
  delete (globalThis as unknown as { MediaMetadata?: unknown }).MediaMetadata;
});

describe('MusicPlayerProvider — MediaSession integration', () => {
  it('registers the play/pause/next/prev/stop (and seekto) action handlers on mount', () => {
    renderProvider();
    expect(typeof handlers.play).toBe('function');
    expect(typeof handlers.pause).toBe('function');
    expect(typeof handlers.nexttrack).toBe('function');
    expect(typeof handlers.previoustrack).toBe('function');
    expect(typeof handlers.stop).toBe('function');
    expect(typeof handlers.seekto).toBe('function');
  });

  // Task 2: seekbackward/seekforward are podcast controls (±10s). iOS gives
  // them priority over nexttrack/previoustrack and shows ±10s buttons on the
  // lock screen instead — exactly the bug the owner reported a screenshot of.
  it('does NOT register seekbackward/seekforward — they displace the next/prev buttons on the lock screen', () => {
    renderProvider();
    expect(handlers.seekbackward).toBeUndefined();
    expect(handlers.seekforward).toBeUndefined();
  });

  it('the stop handler pauses playback', () => {
    renderProvider();
    act(() => api.playNow([track], 0));
    expect(api.isPlaying).toBe(true);

    act(() => handlers.stop?.({}));

    expect(api.isPlaying).toBe(false);
  });

  it('publishes the current track metadata (title / artist / artwork) when a track plays', () => {
    renderProvider();
    act(() => api.playNow([track], 0));

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Song One');
    expect(metadata?.artist).toBe('Artist One');
    // Artwork is derived from the same cover URL the UI renders.
    expect(metadata?.artwork.length).toBeGreaterThan(0);
    expect(metadata?.artwork[0].src).toContain('/jellyfin/Items/a/Images/Primary');
    expect(metadata?.artwork.some((a) => a.src.includes('maxWidth=512'))).toBe(true);
  });

  it('mirrors playbackState: playing after playNow, paused after toggle', () => {
    renderProvider();
    act(() => api.playNow([track], 0));
    expect(playbackState).toBe('playing');

    act(() => api.toggle());
    expect(playbackState).toBe('paused');
  });

  it('the lock-screen next / prev / pause handlers drive the queue', () => {
    const tracks: MusicTrack[] = [
      { ...track, itemId: 'a', title: 'A' },
      { ...track, itemId: 'b', title: 'B' },
    ];
    renderProvider();
    act(() => api.playNow(tracks, 0));
    expect(api.currentIndex).toBe(0);

    act(() => handlers.nexttrack?.({}));
    expect(api.currentIndex).toBe(1);

    act(() => handlers.previoustrack?.({}));
    expect(api.currentIndex).toBe(0);

    act(() => handlers.pause?.({}));
    expect(api.isPlaying).toBe(false);
    expect(playbackState).toBe('paused');

    act(() => handlers.play?.({}));
    expect(api.isPlaying).toBe(true);
    expect(playbackState).toBe('playing');
  });

  it('clears metadata handlers on unmount', () => {
    const { unmount } = renderProvider();
    act(() => api.playNow([track], 0));
    unmount();
    expect(handlers.play).toBeNull();
    expect(handlers.nexttrack).toBeNull();
    expect(handlers.stop).toBeNull();
  });
});

describe('MusicPlayerProvider — setPositionState honesty (Task 3)', () => {
  const durationTrack: MusicTrack = { ...track, itemId: 'dur-track', durationSeconds: 180 };

  it('publishes position 0 / the known duration immediately on load, before any timeupdate tick', () => {
    renderProvider();
    setPositionState.mockClear();

    act(() => api.playNow([durationTrack], 0));

    expect(setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 180, position: 0 }),
    );
  });

  it('reports playbackRate 0 with the frozen position when the audio actually pauses', () => {
    renderProvider();
    act(() => api.playNow([durationTrack], 0));
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 180 });
    audio.currentTime = 42;
    setPositionState.mockClear();

    // A REAL pause from the media element, not the app-level toggle — this is
    // what iOS fires when playback genuinely stops, and it's the exact case
    // that used to leave the OS interpolating the position forever.
    act(() => fireEvent.pause(audio));

    expect(setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 180, position: 42, playbackRate: 0 }),
    );
  });

  it('reports playbackRate 0 immediately on a stall (waiting), without waiting for the buffering settle window', () => {
    renderProvider();
    act(() => api.playNow([durationTrack], 0));
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 180 });
    audio.currentTime = 10;
    setPositionState.mockClear();

    act(() => fireEvent.waiting(audio));

    expect(setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 180, position: 10, playbackRate: 0 }),
    );
  });

  it('does NOT report a frozen position for the ended-then-pause Safari sequence (that pause is not real)', () => {
    renderProvider();
    act(() => api.playNow([durationTrack], 0));
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 180 });
    Object.defineProperty(audio, 'ended', { configurable: true, value: true });
    setPositionState.mockClear();

    act(() => {
      fireEvent.ended(audio);
      fireEvent.pause(audio);
    });

    expect(setPositionState).not.toHaveBeenCalledWith(
      expect.objectContaining({ playbackRate: 0 }),
    );
  });
});
