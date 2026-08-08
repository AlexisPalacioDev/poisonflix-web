import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerScreen } from './PlayerScreen';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItem, getItems, getPlaybackInfo } from '../../api/jellyfin';
import { ApiError } from '../../lib/http/errors';
import {
  clearAudioPreference,
  clearSubtitlePreference,
  setAudioPreference,
  setSubtitlePreference,
} from '../../lib/domain/playerPrefs';
import { queryKeys } from '../../hooks/queryKeys';

vi.mock('../../api/jellyfin', async () => {
  const actual = await vi.importActual<typeof import('../../api/jellyfin')>('../../api/jellyfin');
  return {
    ...actual,
    getPlaybackInfo: vi.fn(),
    getItem: vi.fn(),
    // Episode prev/next/jump navigation (owner request): `getItems` is what
    // `useSeriesEpisodeList` calls to fetch a series' episode list.
    getItems: vi.fn(),
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
    // Real hls.js exposes these once MANIFEST_PARSED fires - empty/-1 here
    // mirrors the common case a Jellyfin transcode actually produces
    // (exactly one server-picked audio rendition, see VideoSurface.tsx's
    // header), so `attemptInBandAudioSwitch`'s hls branch reads a real
    // (empty) array instead of throwing on `undefined.length`.
    audioTracks: unknown[] = [];
    audioTrack = -1;

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
const mockedGetItems = vi.mocked(getItems);

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
  // `clearAudioPreference` matters as much as the subtitle one: a remembered
  // audio LANGUAGE outranks the file's own default, so one leaking into a
  // later block makes `resolveInitialAudio` pick a track the server isn't
  // serving, which re-resolves PlaybackInfo and breaks that block's
  // call-count assertions. It leaked intermittently rather than always
  // because whether the preference got written depended on the async effect
  // landing before the test ended.
  // `cleanup()` FIRST, and that order is the whole point. Vitest runs
  // afterEach hooks innermost-first, so this block's hook fires BEFORE
  // Testing Library's automatic unmount. Resetting the spies here while the
  // component is still mounted leaves its in-flight effects free to call
  // `getPlaybackInfo` afterwards, and that late call lands inside the NEXT
  // test's window - which is exactly how a `jf-item-tracks` request showed up
  // in a `jf-item-a` test and made the call-count assertion flaky under load.
  // Unmounting first stops the effects, then the reset is meaningful.
  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    hlsInstances.length = 0;
    clearSubtitlePreference();
    clearAudioPreference();
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

  // Was missing entirely - later describe blocks in this file that assert on
  // `mockedGetPlaybackInfo` call counts (see the "Spanish must never be
  // missing" block below) would otherwise inherit this block's leaked,
  // un-reset call history.
  // `cleanup()` FIRST, and that order is the whole point. Vitest runs
  // afterEach hooks innermost-first, so this block's hook fires BEFORE
  // Testing Library's automatic unmount. Resetting the spies here while the
  // component is still mounted leaves its in-flight effects free to call
  // `getPlaybackInfo` afterwards, and that late call lands inside the NEXT
  // test's window - which is exactly how a `jf-item-tracks` request showed up
  // in a `jf-item-a` test and made the call-count assertion flaky under load.
  // Unmounting first stops the effects, then the reset is meaningful.
  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    hlsInstances.length = 0;
    clearSubtitlePreference();
    // This block SELECTS tracks, so it is the one most likely to persist an
    // audio preference into the next block. Same reason as above.
    clearAudioPreference();
    vi.clearAllMocks();
  });

  it('renders the audio and subtitle track buttons once tracks load', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    expect(await screen.findByRole('button', { name: 'Audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subtítulos' })).toBeInTheDocument();
  });

  // Real-Chrome audit finding: the track menu used to portal unconditionally
  // to `document.body`, which put it OUTSIDE the real Fullscreen API's
  // element (never rendered while fullscreen) and behind the pseudo-
  // fullscreen surface's `z-index: 9999` on iOS Safari (rendered, but hidden
  // behind the black video). `VideoSurface` now passes its own surface as
  // the menu's portal `container`, so the dialog stays inside it regardless
  // of fullscreen state. jsdom implements neither the Fullscreen API nor
  // real paint, so this only proves the portal TARGET - real on-screen
  // visibility in either fullscreen mode is an on-device acceptance check.
  it('portals the track menu inside the player surface, not document.body', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Audio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Audio' });
    const surface = document.querySelector('.pf-player-surface');

    expect(surface).not.toBeNull();
    expect(surface).toContainElement(dialog);
    expect(dialog.parentElement).not.toBe(document.body);
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

  // Regression: `useItemMediaStreams` must NOT share `queryKeys.item` with
  // Detail's `useLibraryItem`. That key caches the raw `JellyfinItem` object;
  // opening a movie's Detail then playing it used to hand the player a
  // non-array `data`, crashing `audioTracksOf` with "n.filter is not a
  // function" (the "Unexpected Application Error" screen). Seeding the shared
  // key with the raw object up-front reproduces that exact ordering.
  it('does not crash when queryKeys.item is already cached as a raw item object (Detail visited first)', async () => {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    const itemId = 'jf-item-tracks';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // What Detail's useLibraryItem leaves in the cache: the RAW item object.
    queryClient.setQueryData(queryKeys.item(itemId), {
      Id: itemId,
      Name: 'Track menu movie',
      MediaStreams: mediaStreams,
    });

    render(
      <MemoryRouter initialEntries={[`/player/${itemId}`]}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TestRouteTree />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // The player's own (separately-keyed) query resolves to a real track list…
    expect(await screen.findByRole('button', { name: 'Audio' })).toBeInTheDocument();
    // …and the raw-object shape never reached audioTracksOf.
    expect(screen.queryByText(/filter is not a function/i)).not.toBeInTheDocument();
  });
});

// Regression: a movie opened in English audio with no subtitle selected at
// all - the owner's rule is "está bien que hayan las 2 opciones, en inglés y
// en español, pero nunca debe faltar el español". These exercise the full
// PlayerScreen wiring (not just the domain functions in playerPrefs.test.ts)
// for the initial audio/subtitle pick.
describe('PlayerScreen — Spanish must never be missing on open (owner rule)', () => {
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

  // `cleanup()` FIRST, and that order is the whole point. Vitest runs
  // afterEach hooks innermost-first, so this block's hook fires BEFORE
  // Testing Library's automatic unmount. Resetting the spies here while the
  // component is still mounted leaves its in-flight effects free to call
  // `getPlaybackInfo` afterwards, and that late call lands inside the NEXT
  // test's window - which is exactly how a `jf-item-tracks` request showed up
  // in a `jf-item-a` test and made the call-count assertion flaky under load.
  // Unmounting first stops the effects, then the reset is meaningful.
  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    hlsInstances.length = 0;
    clearSubtitlePreference();
    clearAudioPreference();
    vi.clearAllMocks();
  });

  it('(a) English-only audio + a Spanish subtitle: audio stays English, the Spanish subtitle is auto-selected', async () => {
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-a',
      Name: 'English audio, Spanish subs',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-a');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const subtitleDialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    expect(within(subtitleDialog).getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(subtitleDialog).getByRole('button', { name: 'Cerrar' }));

    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    const audioDialog = await screen.findByRole('dialog', { name: 'Audio' });
    expect(within(audioDialog).getByRole('button', { name: 'Inglés' })).toHaveAttribute('aria-pressed', 'true');

    // Audio never had to be re-resolved (it stayed the file's own default).
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
  });

  it('(b) Spanish + English audio: Spanish audio is auto-selected, subtitles stay off', async () => {
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-b',
      Name: 'Spanish + English audio',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
        { Index: 3, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-b');
    const video = await screen.findByTestId('pf-video');
    // Real Chromium has no `HTMLMediaElement.audioTracks` at all (see
    // VideoSurface.tsx's header), so the in-band attempt always fails there
    // - but it only gets ATTEMPTED (and the server round-trip fallback only
    // triggers) once the browser has had a real chance to populate its own
    // track list, i.e. at `canplay`/`loadedmetadata` (VideoSurface's
    // `audioReadyForInBandRef` gate). jsdom never fires that on its own.
    fireEvent.canPlay(video);

    // The file's default (index 1, English) differs from the resolved
    // preference (index 2, Spanish) - PlayerScreen must re-resolve
    // PlaybackInfo with the Spanish AudioStreamIndex.
    await vi.waitFor(() => {
      expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2);
    });
    // Root cause of the owner's exact bug report ("elijo un audio, salgo y
    // vuelvo, y vuelve a salir el audio por defecto en inglés"), verified
    // against a real Jellyfin server (v10.11.11, `MediaInfoHelper.cs`
    // `SetDeviceSpecificData`, ~L206-211): the server ONLY honors
    // `AudioStreamIndex`/`SubtitleStreamIndex` from the request body when
    // `MediaSourceId` is ALSO present and matches a real `MediaSource` on the
    // item - live-confirmed via `PlaybackInfo` probes against production:
    // omitting `MediaSourceId` made the server silently fall back to the
    // file's OWN default audio/subtitle, discarding the requested index
    // entirely, for BOTH DirectPlay and already-transcoding sources alike.
    // Without this field, `handleAudioSwitchUnavailable`'s re-resolve is a
    // structural no-op no matter what `AudioStreamIndex` it sends.
    expect(mockedGetPlaybackInfo).toHaveBeenNthCalledWith(
      2,
      'jf-item-b',
      expect.objectContaining({ audioStreamIndex: 2, mediaSourceId: 'ms-1' }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Audio' }));
    const audioDialog = await screen.findByRole('dialog', { name: 'Audio' });
    expect(within(audioDialog).getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(audioDialog).getByRole('button', { name: 'Cerrar' }));

    fireEvent.click(screen.getByRole('button', { name: 'Subtítulos' }));
    const subtitleDialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    expect(within(subtitleDialog).getByRole('button', { name: 'Ninguno' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('(c) English-only audio, no Spanish subtitle available: unchanged - no crash, subtitles stay off', async () => {
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-c',
      Name: 'English audio, French subs only',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Subtitle', Language: 'fre', DisplayTitle: 'Français', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-c');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const subtitleDialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    expect(within(subtitleDialog).getByRole('button', { name: 'Ninguno' })).toHaveAttribute('aria-pressed', 'true');

    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
  });

  it('(e) a saved audio preference wins over the automatic Spanish pick', async () => {
    setAudioPreference('en');
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-e',
      Name: 'Spanish + English audio, English preferred',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-e');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Audio' }));
    const audioDialog = await screen.findByRole('dialog', { name: 'Audio' });
    expect(within(audioDialog).getByRole('button', { name: 'Inglés' })).toHaveAttribute('aria-pressed', 'true');

    // The saved preference matched the file's own default - no re-resolve needed.
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
  });

  // Regression for the owner's exact bug report: "si me meto a la
  // configuración de los subtítulos, aparece el español seleccionado. Aun
  // así, no se están mostrando." The menu (React state) has always reflected
  // the saved preference correctly - every test above proves that via
  // `aria-pressed`. What was never asserted anywhere in this suite is
  // whether the preference reaches the actual `<video>`'s TextTrack. Root
  // cause: `VideoSurface`'s `initialSubtitleAppliedRef` "apply once" guard
  // is consumed by an effect keyed ONLY on the resolved stream `key`
  // (available as soon as `usePlaybackInfo` resolves), which fires BEFORE
  // `PlayerScreen`'s own `[mediaStreams.data]` effect has had a chance to
  // set the real `selectedSubtitleIndex` - `mediaStreams` is a separate,
  // independently-timed query (`useItemMediaStreams`). The guard fires once
  // with `selectedSubtitleIndex` still `null`, marks itself "done", and
  // never retries once the real preference/tracks arrive a render later.
  it('(d) a saved subtitle preference is actually applied to the <video> TextTrack, not just shown as checked in the menu', async () => {
    setSubtitlePreference('es');
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-d',
      Name: 'English audio, Spanish + English subs',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
        { Index: 3, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-d');
    const video = (await screen.findByTestId('pf-video')) as HTMLVideoElement;

    // State layer: the menu shows Español checked (this already passed
    // before the fix - it is NOT the bug).
    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    expect(within(dialog).getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));

    // Reality layer: the actual sideloaded <track> for Spanish must be
    // 'showing', and the English one must stay 'disabled' - this is what
    // was broken.
    await vi.waitFor(() => {
      const spanishTrack = video.querySelector('track[srclang="spa"]') as HTMLTrackElement | null;
      expect(spanishTrack?.track?.mode).toBe('showing');
    });
    const englishTrack = video.querySelector('track[srclang="eng"]') as HTMLTrackElement | null;
    expect(englishTrack?.track?.mode).toBe('disabled');
  });

  // Same bug, audio side: `handleAudioSwitchUnavailable`'s server re-resolve
  // is the ONLY mechanism the initial-selection effect (PlayerScreen,
  // `[mediaStreams.data]`) ever tries when the resolved preference differs
  // from the file's own default - it never attempts the in-band
  // `HTMLMediaElement.audioTracks` switch first, unlike the user's own
  // manual pick (`VideoSurface.handleSelectAudio`), which tries in-band
  // BEFORE falling back to the same re-resolve. When the browser genuinely
  // supports in-band switching (seeded here via jsdom's real, mutable
  // `audioTracks` Array - confirmed structurally identical to a real one),
  // the initial restore must use it too, exactly like a manual pick would -
  // and must NOT waste an extra PlaybackInfo round trip once it succeeds.
  it('(f) a saved audio preference is actually applied in-band to the <video>, not just re-requested from the server', async () => {
    setAudioPreference('spa');
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-f',
      Name: 'Spanish + English audio, Spanish preferred',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-f');
    // Typed through a local shape rather than `HTMLVideoElement`: the DOM lib
    // has no `audioTracks` because Chromium genuinely does not ship it (that
    // absence is the whole reason the in-band path needs a server fallback).
    // jsdom leaves the slot writable, which is what lets this test seed it.
    const video = (await screen.findByTestId('pf-video')) as unknown as HTMLVideoElement & {
      audioTracks: { enabled: boolean }[];
    };
    // Simulate a browser that DOES expose in-band audio tracks (jsdom's
    // `audioTracks` is a real, mutable Array - see VideoSurface.tsx's own
    // `BrowserAudioTrackList` shape) - ordinal-matched to the two Audio
    // MediaStreams above (English first, Spanish second). Populated BEFORE
    // `canplay`, matching a real browser: the track list is ready by the
    // time the media is playable, not before.
    video.audioTracks.push({ enabled: true } as never, { enabled: false } as never);
    fireEvent.canPlay(video);

    await vi.waitFor(() => {
      expect((video.audioTracks[1] as unknown as { enabled: boolean }).enabled).toBe(true);
    });
    expect((video.audioTracks[0] as unknown as { enabled: boolean }).enabled).toBe(false);
    // Applied in-band - the server never needed a second opinion.
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
  });
});

// Regression for a bug introduced (and caught by review) WHILE fixing the
// two above: making the initial-restore effect retry until it can genuinely
// apply the selection is correct for subtitles (nothing about applying one
// changes the resolved `source`), but audio's fallback - re-resolving
// `PlaybackInfo` with `AudioStreamIndex` - genuinely PRODUCES a new
// resolved source for a Transcoded session (a fresh `TranscodingUrl`/
// `PlaySessionId` per Jellyfin request). An early version of the fix reset
// its "already applied" guard on every source change, including the one the
// fallback itself causes - so the freshly-reopened source's own
// `MANIFEST_PARSED` re-evaluated the same mismatch, re-triggered the same
// fallback, reopened AGAIN, forever: playback restarting in an unbounded
// loop instead of landing on the picked language once.
describe('PlayerScreen — audio restore must not spin into an unbounded re-resolve loop (regression)', () => {
  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    hlsInstances.length = 0;
    clearSubtitlePreference();
    clearAudioPreference();
    vi.clearAllMocks();
  });

  it('a Transcoded source with no in-band audio switching re-resolves EXACTLY once, even if the server hands back a fresh session each time', async () => {
    setAudioPreference('spa');
    // A fresh `TranscodingUrl`/`PlaySessionId` per call - the realistic
    // Jellyfin shape that turned "reset on every source change" into an
    // infinite loop (a stable URL would have masked the bug: the resolved
    // `key` wouldn't even have changed on the second call).
    let call = 0;
    mockedGetPlaybackInfo.mockImplementation(async () => {
      call += 1;
      return {
        MediaSources: [
          {
            Id: 'ms-1',
            Container: 'mkv',
            TranscodingUrl: `/videos/item-loop/master-${call}.m3u8`,
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            MediaStreams: [],
          },
        ],
        PlaySessionId: `sess-${call}`,
      } as never;
    });
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-loop',
      Name: 'Transcoded, Spanish preferred',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-loop');
    await screen.findByTestId('pf-video');

    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(1));
    // First MANIFEST_PARSED: the resolved index (Spanish) differs from the
    // file's default (English) and this session offers no in-band audio
    // rendition to switch to (`audioTracks: []`) - must fall back exactly
    // once.
    hlsInstances[0].handlers.hlsManifestParsed?.();
    await vi.waitFor(() => expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2));

    // The fallback's re-resolve produced a genuinely new source (fresh
    // TranscodingUrl) - a second hls.js instance is expected and correct.
    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(2));
    // Firing MANIFEST_PARSED on THIS instance too (exactly what a real
    // reopened stream does) must NOT trigger a third re-resolve - the
    // selection is already "applied" (decided) for this index.
    hlsInstances[1].handlers.hlsManifestParsed?.();
    // No `waitFor` growth expected - assert the count stays put after
    // flushing microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2);
  });
});

// Subtitle dedup bug fix (player spec, live evidence: Solo Leveling S02E02 -
// PlaybackInfo returned `{ Index: 2, Codec: 'ass', DeliveryMethod: 'Encode' }`
// and the ORIGINAL file has no burned-in text at t=117s per an ffmpeg frame
// extraction, so Jellyfin adds it during transcode). End-to-end through the
// real PlayerScreen -> VideoSurface wiring, not just VideoSurface's own
// prop-level tests (VideoSurface.test.tsx) - this is what actually reaches
// the <video> in the reported bug.
describe('PlayerScreen — burned-in subtitle dedup (subtitle dedup bug fix)', () => {
  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    hlsInstances.length = 0;
    clearSubtitlePreference();
    clearAudioPreference();
    vi.clearAllMocks();
  });

  it('mounts no client-side <track> for the burned-in subtitle, but still shows it SELECTED in the menu', async () => {
    setSubtitlePreference('fre');
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mkv',
          TranscodingUrl: '/videos/item-burn/master.m3u8',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          MediaStreams: [
            { Index: 1, Type: 'Audio' },
            { Index: 2, Type: 'Subtitle', Codec: 'ass', DeliveryMethod: 'Encode' },
          ],
        },
      ],
      PlaySessionId: 'sess-burn-1',
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-burn',
      Name: 'Solo Leveling S02E02',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'jpn', DisplayTitle: 'Japanese', IsDefault: true },
        { Index: 2, Type: 'Subtitle', Language: 'fre', DisplayTitle: 'Français', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-burn');
    const video = (await screen.findByTestId('pf-video')) as HTMLVideoElement;

    // Reality layer: the exact bug - no sideloaded <track> may exist for the
    // stream the server already burned in, or the same text renders twice.
    await vi.waitFor(() => {
      expect(video.querySelectorAll('track')).toHaveLength(0);
    });

    // Menu layer: the user IS effectively watching French subtitles - the
    // menu must keep showing that, even though the client renders nothing
    // for it. French isn't a "primary" language (TrackMenu's
    // Español/Inglés-first fold), so it starts behind "Más subtítulos".
    fireEvent.click(screen.getByRole('button', { name: 'Subtítulos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Más subtítulos/ }));
    expect(within(dialog).getByRole('button', { name: 'Francés' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('picking "Ninguno" while a subtitle is burned in re-resolves PlaybackInfo with SubtitleStreamIndex: -1 (turning it off is a server re-transcode, not a client toggle)', async () => {
    setSubtitlePreference('fre');
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mkv',
          TranscodingUrl: '/videos/item-burn/master.m3u8',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          MediaStreams: [{ Index: 2, Type: 'Subtitle', Codec: 'ass', DeliveryMethod: 'Encode' }],
        },
      ],
      PlaySessionId: 'sess-burn-2',
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-burn-2',
      Name: 'Solo Leveling S02E02',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'jpn', DisplayTitle: 'Japanese', IsDefault: true },
        { Index: 2, Type: 'Subtitle', Language: 'fre', DisplayTitle: 'Français', IsDefault: false },
      ],
    } as never);

    renderPlayer('jf-item-burn-2');
    await screen.findByTestId('pf-video');
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Subtítulos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ninguno' }));

    await vi.waitFor(() => expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2));
    expect(mockedGetPlaybackInfo).toHaveBeenNthCalledWith(
      2,
      'jf-item-burn-2',
      expect.objectContaining({ subtitleStreamIndex: -1 }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const reopenedDialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    expect(within(reopenedDialog).getByRole('button', { name: 'Ninguno' })).toHaveAttribute('aria-pressed', 'true');
  });
});

// Episode prev/next/jump navigation (owner request: navigate between a
// series' chapters from the player). End-to-end through the real router -
// VideoSurface.test.tsx already covers the button rendering/disabled-state
// rules with plain props; this exercises the actual `navigate('/player/:id')`
// wiring PlayerScreen owns, and that `usePlaybackInfo` re-fetches for the
// item landed on.
describe('PlayerScreen — episode prev/next/jump navigation (owner request)', () => {
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

  function itemFor(itemId: string) {
    const byId: Record<string, unknown> = {
      'jf-ep-1': {
        Id: 'jf-ep-1',
        Name: 'Episode One',
        Type: 'Episode',
        SeriesId: 'series-1',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      },
      'jf-ep-2': {
        Id: 'jf-ep-2',
        Name: 'Episode Two',
        Type: 'Episode',
        SeriesId: 'series-1',
        ParentIndexNumber: 1,
        IndexNumber: 2,
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      },
    };
    return byId[itemId];
  }

  beforeEach(() => {
    mockedGetPlaybackInfo.mockResolvedValue(mediaSources as never);
    mockedGetItem.mockImplementation(async (_userId, itemId) => itemFor(itemId) as never);
    mockedGetItems.mockResolvedValue({
      Items: [
        { Id: 'jf-ep-1', Name: 'Episode One', ParentIndexNumber: 1, IndexNumber: 1 },
        { Id: 'jf-ep-2', Name: 'Episode Two', ParentIndexNumber: 1, IndexNumber: 2 },
      ],
      TotalRecordCount: 2,
      StartIndex: 0,
    } as never);
  });

  afterEach(() => {
    cleanup();
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
    mockedGetItems.mockReset();
    hlsInstances.length = 0;
    clearSubtitlePreference();
    clearAudioPreference();
    vi.clearAllMocks();
  });

  it('a movie renders none of the three episode controls', async () => {
    mockedGetItem.mockResolvedValue({
      Id: 'jf-movie-1',
      Name: 'A Movie',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
    } as never);

    renderPlayer('jf-movie-1');
    await screen.findByTestId('pf-video');

    expect(screen.queryByRole('button', { name: 'Episodio anterior' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Episodio siguiente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Episodios' })).not.toBeInTheDocument();
    // Never fetches a series episode list for a movie.
    expect(mockedGetItems).not.toHaveBeenCalled();
  });

  it('clicking "Episodio siguiente" navigates the player to the next episode', async () => {
    renderPlayer('jf-ep-1');

    const video = (await screen.findByTestId('pf-video')) as HTMLVideoElement;
    expect(video).toHaveAttribute('src', expect.stringContaining('jf-ep-1'));
    expect(screen.getByRole('button', { name: 'Episodio anterior' })).toBeDisabled();

    fireEvent.click(await screen.findByRole('button', { name: 'Episodio siguiente' }));

    await vi.waitFor(() => {
      expect(screen.getByTestId('pf-video')).toHaveAttribute('src', expect.stringContaining('jf-ep-2'));
    });
    expect(screen.getByRole('button', { name: 'Episodio siguiente' })).toBeDisabled();
  });

  it('selecting an episode from the jump menu navigates to that episode', async () => {
    renderPlayer('jf-ep-1');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Episodios' }));
    const dialog = await screen.findByRole('dialog', { name: 'Episodios' });
    fireEvent.click(within(dialog).getByRole('button', { name: /T1 E2/ }));

    await vi.waitFor(() => {
      expect(screen.getByTestId('pf-video')).toHaveAttribute('src', expect.stringContaining('jf-ep-2'));
    });
  });
});
