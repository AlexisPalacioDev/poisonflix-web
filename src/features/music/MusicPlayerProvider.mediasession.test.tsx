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
  it('registers the play/pause/next/prev (and seekto) action handlers on mount', () => {
    renderProvider();
    expect(typeof handlers.play).toBe('function');
    expect(typeof handlers.pause).toBe('function');
    expect(typeof handlers.nexttrack).toBe('function');
    expect(typeof handlers.previoustrack).toBe('function');
    expect(typeof handlers.seekto).toBe('function');
  });

  // Task 2: seekbackward/seekforward are podcast controls (±10s). iOS gives
  // them priority over nexttrack/previoustrack and shows ±10s buttons on the
  // lock screen instead — exactly the bug the owner reported a screenshot of.
  it('actively CLEARS seekbackward/seekforward — they displace next/prev on the lock screen', () => {
    // Strengthened after the owner reported the lock screen offering ±10s and
    // no way to change track. Not registering them is not the same as
    // clearing them: `navigator.mediaSession` is global to the document and
    // its handlers outlive any component, so anything that ever set them
    // leaves them in place and iOS keeps drawing the skip pair. The provider
    // now sets them to null explicitly, which is what "no handler" has to mean
    // on a session it does not exclusively own.
    renderProvider();
    expect(handlers.seekbackward ?? null).toBeNull();
    expect(handlers.seekforward ?? null).toBeNull();
  });

  it('re-asserts the transport handlers when the playing element rotates', () => {
    // WebKit rebuilds the now-playing session around whichever media element
    // is active, and the mixer rotates between three of them — so handlers
    // attached once at mount may not belong to the session iOS is drawing from
    // the second track onward. When it cannot see next/previous, it falls back
    // to its own default transport: the ±10s pair the owner sees.
    const queue: MusicTrack[] = [
      { ...track, itemId: 'a', title: 'A' },
      { ...track, itemId: 'b', title: 'B' },
    ];
    renderProvider();
    act(() => api.playNow(queue, 0));
    handlers.nexttrack = undefined as unknown as MediaSessionActionHandler;
    handlers.previoustrack = undefined as unknown as MediaSessionActionHandler;

    // A track change rotates the active element.
    act(() => api.next());

    expect(typeof handlers.nexttrack).toBe('function');
    expect(typeof handlers.previoustrack).toBe('function');
  });

  it('never hands the OS a stop handler, because that is what let it stop us', () => {
    // This test used to assert the opposite (43e1a32), then got reverted back
    // to asserting `stop` IS registered (f79cb82) on the theory that the
    // owner had been testing in a private/incognito tab. He has since
    // confirmed he was not — the revert's premise was false. The device
    // traces from useLockDiagnostics back that up: playback dies 50-180s
    // after screen lock, right after two `stalled` events, which is a
    // buffering pattern, not a private-tab artifact.
    //
    // Registering `stop` gives the system permission to end playback: it is
    // invoked when the media notification is dismissed or the app is
    // backgrounded, which is what locking the screen does. A missing
    // lock-screen button is a smaller loss than a pause nobody asked for.
    renderProvider();
    act(() => api.playNow([track], 0));

    expect(handlers.stop).toBeUndefined();
    expect(api.isPlaying).toBe(true);
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

  it('mirrors playbackState: playing after playNow AND a confirmed `playing` event, paused after toggle', () => {
    renderProvider();
    act(() => api.playNow([track], 0));
    // Intent to play is there (`api.isPlaying === true`), but the element has
    // not yet confirmed real audio — see the "does not report" test below for
    // why this must stay 'paused' here, not 'playing'.
    expect(playbackState).toBe('paused');

    act(() => fireEvent.playing(document.querySelector('audio') as HTMLAudioElement));
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
    // Not 'playing' yet — no confirmed `playing` event for this resume.
    expect(playbackState).toBe('paused');
    act(() => fireEvent.playing(document.querySelector('audio') as HTMLAudioElement));
    expect(playbackState).toBe('playing');
  });

  it('does NOT report "playing" merely from intent — only once the element confirms real audio at least once', () => {
    // The bug this fixes: `state.isPlaying` flips true the instant a gesture
    // dispatches, well before the browser resumes audio. Every measured
    // 60-110s on-device hang showed `mediaSessionState: 'playing'` for its
    // ENTIRE length, from the very first sample, because nothing here ever
    // checked for a real `playing` event before making the claim.
    renderProvider();
    act(() => api.playNow([track], 0));
    expect(api.isPlaying).toBe(true);
    expect(playbackState).not.toBe('playing');

    const audio = document.querySelector('audio') as HTMLAudioElement;
    act(() => fireEvent.playing(audio));
    expect(playbackState).toBe('playing');
  });

  it('does NOT revert to "paused" on a mid-stream stall once already confirmed playing (43e1a32/2bbcde9)', () => {
    // This is the deliberately narrower half of the fix above, added after
    // adversarial review flagged the first version for reverting on every
    // `waiting`/`stalled` too. That is the exact "tell the OS the music
    // stopped when it is only buffering" mistake `43e1a32` (reverted by a
    // wrong theory in `f79cb82`, then fixed for real in `2bbcde9`) already
    // proved cost the owner his audio on every lock screen — there through
    // `setPositionState`'s `playbackRate`, here it would be the same lie
    // through `playbackState` instead. A stall mid-track means bytes are
    // late, not that the CURRENT attempt's `playing` confirmation stops
    // having happened.
    renderProvider();
    act(() => api.playNow([track], 0));
    const audio = document.querySelector('audio') as HTMLAudioElement;
    act(() => fireEvent.playing(audio));
    expect(playbackState).toBe('playing');

    act(() => fireEvent.waiting(audio));
    expect(api.isPlaying).toBe(true);
    expect(playbackState).toBe('playing'); // NOT reverted

    act(() => fireEvent.stalled(audio));
    expect(playbackState).toBe('playing'); // still not reverted

    // A REAL pause is the one thing that does correctly flip it.
    act(() => fireEvent.pause(audio));
    expect(playbackState).toBe('paused');
  });

  it('clears metadata handlers on unmount', () => {
    const { unmount } = renderProvider();
    act(() => api.playNow([track], 0));
    unmount();
    expect(handlers.play).toBeNull();
    expect(handlers.nexttrack).toBeNull();
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

  it('does NOT report a stopped playhead while merely buffering', () => {
    // This asserted the opposite (43e1a32 reverted by f79cb82, on the false
    // premise the owner was testing in a private/incognito tab — he has
    // confirmed he was not). `playbackRate: 0` tells the OS the session is
    // not playing; `waiting`/`stalled` mean bytes are late, not that
    // playback ended — and a phone that has just locked throttles the
    // network, so those events fire exactly then. The device traces show
    // playback dying 50-180s after lock, right after two `stalled` events,
    // which matches this exactly.
    //
    // The cost of this is a lock-screen scrubber that creeps for a second
    // while buffering. That is worth paying.
    renderProvider();
    act(() => api.playNow([durationTrack], 0));
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 180 });
    audio.currentTime = 42;
    setPositionState.mockClear();

    act(() => fireEvent(audio, new Event('waiting')));
    act(() => fireEvent(audio, new Event('stalled')));

    expect(setPositionState).not.toHaveBeenCalledWith(
      expect.objectContaining({ playbackRate: 0 }),
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

describe('MusicPlayerProvider — the OS is told playback started, not that it is pending', () => {
  it('reports playing while the tone holds the session, before the track confirms', () => {
    // THE BUG THIS IS FOR: the owner got no lock-screen panel at all, and had
    // to keep waiting before he could lock the phone. `audioConfirmedPlaying`
    // is false until the TRACK fires its first `playing`, which on a cold
    // stream is 5-10 seconds after the tap — and iOS draws no now-playing
    // panel for a session it has been told is paused. The placeholder was
    // holding real audio the whole time; the flag meant to keep this honest
    // was hiding it.
    //
    // Not a lie either: the tone is a real element playing real (inaudible)
    // samples. What `audioConfirmedPlaying` exists to prevent — claiming
    // 'playing' through total silence — is unchanged.
    renderProvider();
    act(() => api.playNow([track], 0));

    const tone = document.querySelector<HTMLAudioElement>('audio[loop]');
    expect(tone).not.toBeNull();
    // jsdom never really starts playback, so say what the gesture achieved.
    Object.defineProperty(tone!, 'paused', { value: false, configurable: true });
    act(() => {
      tone!.dispatchEvent(new Event('play'));
    });

    expect(navigator.mediaSession.playbackState).toBe('playing');
  });

  it('still reports paused when nothing at all is producing audio', () => {
    // The other half: with the tone stopped and the track unconfirmed, there
    // is genuinely no audio, and the OS must not be told otherwise.
    renderProvider();
    act(() => api.playNow([track], 0));

    const tone = document.querySelector<HTMLAudioElement>('audio[loop]');
    Object.defineProperty(tone!, 'paused', { value: true, configurable: true });
    act(() => {
      tone!.dispatchEvent(new Event('pause'));
    });

    expect(navigator.mediaSession.playbackState).toBe('paused');
  });
});

describe('MusicPlayerProvider — the lock-screen pause button is not fought', () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'visibilityState', {
      value: hidden ? 'hidden' : 'visible',
      configurable: true,
    });
  }
  afterEach(() => setHidden(false));

  it('stays paused instead of flapping between pause and play', () => {
    // The flutter this is for: pressing pause on the lock screen produced an
    // endless pause/play loop. There is a rule that answers a pause nobody
    // asked for while the screen is off — iOS stopping playback on its own —
    // and it could not tell that pause from the listener's own, because at the
    // instant the event arrives `stateRef` still says "playing": the dispatch
    // that says otherwise has not been applied yet. So it resumed, which
    // produced another pause, and around it went.
    //
    // The fix records intent at the call site, which is why this test drives
    // the REAL handler rather than the reducer: the ordering only exists on
    // this path.
    renderProvider();
    act(() => api.playNow([track], 0));
    const audio = document.querySelector<HTMLAudioElement>('audio:not([loop])')!;
    // jsdom's mocked pause() never flips `paused`, so say it is sounding —
    // otherwise the intentional pause is a no-op and the race cannot happen.
    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    setHidden(true);
    // This suite stubs play() on the prototype without keeping a handle, so
    // spy on the element itself for the one thing this test measures.
    const playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined);

    act(() => {
      // The registered handler takes a details object it does not read.
      handlers.pause({} as MediaSessionActionDetails);
      // Same tick, before React applies the state — which is the whole
      // difficulty. Splitting these apart lets the state settle first and the
      // bug disappears, which is how a green test could have hidden it.
      audio.dispatchEvent(new Event('pause'));
    });

    expect(playSpy).not.toHaveBeenCalled();
    expect(api.isPlaying).toBe(false);
  });
});
