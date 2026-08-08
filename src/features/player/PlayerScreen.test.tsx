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
  clearSecondSubtitlePreference,
  clearSubtitlePreference,
  getSecondSubtitlePreference,
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
    clearSecondSubtitlePreference();
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
    // Scoped to the PRIMARY group: dual subtitles (owner request) added a
    // "Segundo subtítulo" section below this one that reuses several of the
    // SAME language labels (e.g. "Inglés" can be both the primary pick and a
    // second-slot candidate at once) - an unscoped query against the whole
    // dialog would be ambiguous. `within(dialog)` alone still finds the
    // group (nested containers don't exclude an ancestor's queries), so this
    // narrows on purpose rather than for a "not found" reason.
    const primaryGroup = within(dialog).getByRole('group', { name: 'Subtítulo principal' });
    expect(within(primaryGroup).getByRole('button', { name: 'Ninguno' })).toBeInTheDocument();
    expect(within(primaryGroup).getByRole('button', { name: 'Español' })).toBeInTheDocument();
    expect(within(primaryGroup).getByRole('button', { name: 'Inglés' })).toBeInTheDocument();

    // Folded: French/German aren't shown until "Más subtítulos" is opened.
    expect(within(primaryGroup).queryByText('Francés')).not.toBeInTheDocument();
    expect(within(primaryGroup).queryByText('Alemán')).not.toBeInTheDocument();
    const expandButton = within(primaryGroup).getByRole('button', { name: /Más subtítulos/ });
    expect(expandButton).toHaveTextContent('Más subtítulos (2)');

    fireEvent.click(expandButton);
    expect(within(primaryGroup).getByRole('button', { name: 'Francés' })).toBeInTheDocument();
    expect(within(primaryGroup).getByRole('button', { name: 'Alemán' })).toBeInTheDocument();
  });

  it('selecting a subtitle option closes the menu', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Español' }));

    expect(screen.queryByRole('dialog', { name: 'Subtítulos' })).not.toBeInTheDocument();
  });

  // Dual subtitles (owner request, verbatim: "me gustaría poder leer también
  // los sub en inglés y en español"): the second subtitle preference must be
  // remembered BY LANGUAGE across sessions, the same contract the primary
  // subtitle already has (`playerPrefs.ts`) - exercised here end-to-end
  // through the real screen, not just the domain function in
  // playerPrefs.test.ts.
  it('picking a second subtitle persists it by language and restores it on a fresh mount', async () => {
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const dialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    const secondGroup = within(dialog).getByRole('group', { name: 'Segundo subtítulo' });

    fireEvent.click(within(secondGroup).getByRole('button', { name: 'Inglés' }));

    // Closing the menu (same behavior as picking a primary subtitle) AND
    // persisting by language family, not by this file's stream index.
    expect(screen.queryByRole('dialog', { name: 'Subtítulos' })).not.toBeInTheDocument();
    expect(getSecondSubtitlePreference()).toBe('en');

    // Fresh mount (simulates leaving the player and reopening it) - the
    // saved preference alone, with no interaction, must restore the pick.
    cleanup();
    renderPlayer('jf-item-tracks');
    await screen.findByTestId('pf-video');

    fireEvent.click(await screen.findByRole('button', { name: 'Subtítulos' }));
    const reopenedDialog = await screen.findByRole('dialog', { name: 'Subtítulos' });
    const reopenedSecondGroup = within(reopenedDialog).getByRole('group', { name: 'Segundo subtítulo' });
    expect(await within(reopenedSecondGroup).findByRole('button', { name: 'Inglés' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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

// Owner-reported production bug: "Backrooms: Sin salida" (itemId/
// mediaSourceId `19d008d1f5160dfca15e3960b9932b41`, live evidence - both
// Index 1 (spa) and Index 2 (eng) come back `IsDefault: true` from Jellyfin,
// server's own `DefaultAudioStreamIndex` is 1). Saved audio preference
// 'en'. Timeline captured from `performance.getEntriesByType('resource')`
// against production: open (index1, correct - no pref applied yet) -> pick
// Inglés manually (index2, works) -> exit the player and reenter the SAME
// item -> reopens on index1 FOREVER, even though the menu shows Inglés
// checked and localStorage still has 'en'. The `<video>` was PAUSED
// (autoplay blocked by the browser) at the moment of the bug.
//
// `useItemMediaStreams` (mediaStreams query) and `usePlaybackInfo` are two
// independently-timed queries in production, but every OTHER test in this
// file resolves both through the SAME `mockResolvedValue`/fresh `QueryClient`
// per render - meaning neither their real relative timing NOR a shared
// cache across an unmount+remount of the same item (what "exit and reenter"
// actually is - `App.tsx` creates ONE `QueryClient` for the app's lifetime)
// was ever exercised anywhere else in this suite.
describe('PlayerScreen — audio restore survives exit-and-reenter (owner report: "Backrooms: Sin salida")', () => {
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

  it('mediaStreams resolving AFTER the readiness checkpoint (dual-IsDefault tracks, saved pref differs from the server default) still re-resolves', async () => {
    setAudioPreference('en');
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mkv',
          TranscodingUrl: '/videos/item-g/master.m3u8',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          MediaStreams: [],
        },
      ],
      PlaySessionId: 'sess-g-1',
    } as never);

    let resolveMediaStreamsItem: ((value: unknown) => void) | null = null;
    const mediaStreamsItemPromise = new Promise((resolve) => {
      resolveMediaStreamsItem = resolve;
    });

    mockedGetItem.mockImplementation(async (_userId, _itemId, fields) => {
      if (fields === 'MediaStreams') {
        return mediaStreamsItemPromise as never;
      }
      return {
        Id: 'jf-item-g',
        Name: 'Backrooms: Sin salida',
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      } as never;
    });

    renderPlayer('jf-item-g');
    await screen.findByTestId('pf-video');

    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(1));
    // Readiness checkpoint fires BEFORE mediaStreams resolves - matches the
    // owner's observed order (video paused/autoplay-blocked, second query
    // slower than the first).
    hlsInstances[0].handlers.hlsManifestParsed?.();

    resolveMediaStreamsItem?.({
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
      ],
    });

    await vi.waitFor(() => {
      expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2);
    });
    expect(mockedGetPlaybackInfo).toHaveBeenNthCalledWith(
      2,
      'jf-item-g',
      expect.objectContaining({ audioStreamIndex: 2, mediaSourceId: 'ms-1' }),
    );
  });

  // A SHARED QueryClient across unmount/remount of the SAME item - the real
  // "salgo del player y vuelvo a entrar", not the fresh-QueryClient-per-test
  // shortcut every other test in this file uses (`renderPlayer`). With a
  // shared client and `staleTime: 0` (both queries), a second mount of the
  // same itemId gets BOTH queries' cached data SYNCHRONOUSLY on the very
  // first render (no async gap at all) while a background refetch replaces
  // `data` (and therefore VideoSurface's `key`) moments later.
  it('a shared QueryClient across unmount+remount of the same item still honors the saved audio preference on re-entry', async () => {
    setAudioPreference('en');
    let call = 0;
    mockedGetPlaybackInfo.mockImplementation(async () => {
      call += 1;
      return {
        MediaSources: [
          {
            Id: 'ms-1',
            Container: 'mkv',
            TranscodingUrl: `/videos/item-h/master-${call}.m3u8`,
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            MediaStreams: [],
          },
        ],
        PlaySessionId: `sess-h-${call}`,
      } as never;
    });
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-h',
      Name: 'Backrooms: Sin salida',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
      ],
    } as never);

    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const firstRender = render(
      <MemoryRouter initialEntries={['/player/jf-item-h']}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TestRouteTree />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId('pf-video');
    // First mount reaches a normal, settled state: readiness fires, saved
    // pref ('en') differs from the file's default (spa/index1) - one
    // re-resolve.
    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(1));
    hlsInstances[0].handlers.hlsManifestParsed?.();
    await vi.waitFor(() => expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2));

    firstRender.unmount();
    hlsInstances.length = 0;

    // Re-enter the SAME item with the SAME (now-populated) QueryClient - the
    // real "salgo del player y vuelvo a entrar" scenario.
    render(
      <MemoryRouter initialEntries={['/player/jf-item-h']}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TestRouteTree />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId('pf-video');
    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(1));
    // Let whichever hls instance is CURRENT reach its own readiness
    // checkpoint (mirrors a real MANIFEST_PARSED, whenever it actually
    // lands for the FINAL source).
    hlsInstances[hlsInstances.length - 1].handlers.hlsManifestParsed?.();

    // The saved preference ('en', index 2) must still win on re-entry - a
    // fresh re-resolve carrying audioStreamIndex: 2 is expected.
    await vi.waitFor(() => {
      const englishCall = mockedGetPlaybackInfo.mock.calls.find(
        (c) => (c[1] as { audioStreamIndex?: number })?.audioStreamIndex === 2,
      );
      expect(englishCall).toBeDefined();
    }, { timeout: 3000 });
  });

  // THE confirmed root cause (see `AUDIO_READINESS_FALLBACK_MS`'s doc
  // comment, VideoSurface.tsx): NEITHER readiness checkpoint (hls.js
  // `MANIFEST_PARSED`, nor the <video> `canplay`/`loadedmetadata` DOM
  // events) is guaranteed to fire within any bounded time - a paused,
  // autoplay-blocked `<video>` (confirmed live: the video WAS paused at the
  // moment of the bug) is exactly the kind of state where a browser can
  // legitimately defer that work far longer than "the user is still on this
  // screen". Before the fix, `applyCurrentAudioSelection`'s `allowFallback`
  // gate had EXACTLY those three events as its only paths to `true` - the
  // props-driven retry effect always forwarded whatever
  // `audioReadyForInBandRef.current` currently was, never forcing it `true`
  // on its own - so once genuinely missed, the saved preference was stuck
  // for the rest of that mount, with NO other retry path. Verified RED
  // against the pre-fix code (only 1 `getPlaybackInfo` call, forever); this
  // is the permanent regression test for the fix (a bounded per-source
  // timer, cleared on every `key` change/unmount, giving the fallback one
  // guaranteed second chance).
  it('when neither MANIFEST_PARSED nor canplay ever fires, the saved audio preference still re-resolves via the bounded safety net', { timeout: 8000 }, async () => {
    setAudioPreference('en');
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mkv',
          TranscodingUrl: '/videos/item-i/master.m3u8',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          MediaStreams: [],
        },
      ],
      PlaySessionId: 'sess-i-1',
    } as never);
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-i',
      Name: 'Backrooms: Sin salida',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
      ],
    } as never);

    renderPlayer('jf-item-i');
    await screen.findByTestId('pf-video');
    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(1));

    // Deliberately NEVER fire hlsManifestParsed, canPlay, or loadedMetadata -
    // the video stays "paused, autoplay blocked, nothing ever became ready"
    // for the whole test.
    await vi.waitFor(
      () => {
        expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2);
      },
      { timeout: 6000 },
    );
    expect(mockedGetPlaybackInfo).toHaveBeenNthCalledWith(
      2,
      'jf-item-i',
      expect.objectContaining({ audioStreamIndex: 2, mediaSourceId: 'ms-1' }),
    );
  });

  // Regression for a real gap a `challenger` audit caught in the fix above
  // (`manualAudioPickRef`, VideoSurface.tsx): the bounded safety-net timer
  // races an in-flight MANUAL pick. `handleSelectAudio` marks
  // `appliedAudioIndexRef` with the NEW pick synchronously, but
  // `selectedAudioIndexRef` (React-prop-driven) only catches up once
  // PlayerScreen's own re-resolve promise resolves - a timer firing DURING
  // that window would see the OLD `selectedAudioIndexRef` value, wrongly
  // conclude it "hasn't been applied yet", and fire a SECOND, stale
  // `onAudioSwitchUnavailable` for the index the user just moved away from -
  // a passive restore-the-saved-preference mechanism silently fighting an
  // explicit, still-in-flight user action.
  it('a manual audio pick still in flight is never raced by the readiness safety net', { timeout: 8000 }, async () => {
    // Three tracks, saved preference 'es' (Spanish, index 2 - NOT the file's
    // own default, index 1/English). Deliberate: the safety-net timer's
    // stale read (`selectedAudioIndexRef.current`, unchanged until the
    // in-flight pick's promise resolves) must land on an index that does
    // NOT match the server default - otherwise `applyCurrentAudioSelection`
    // takes its "already matches the file's default, nothing to do" early
    // return (VideoSurface.tsx) regardless of the guard being tested, and
    // the test would pass for the wrong reason. Spanish already differing
    // from the default is exactly what makes the stale read dangerous: it
    // looks like still-unapplied work to a naive re-check.
    let call = 0;
    mockedGetPlaybackInfo.mockImplementation(async () => {
      call += 1;
      return {
        MediaSources: [
          {
            Id: 'ms-1',
            Container: 'mkv',
            TranscodingUrl: `/videos/item-j/master-${call}.m3u8`,
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            MediaStreams: [],
          },
        ],
        PlaySessionId: `sess-j-${call}`,
      } as never;
    });
    mockedGetItem.mockResolvedValue({
      Id: 'jf-item-j',
      Name: 'Backrooms: Sin salida',
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false, IsFavorite: false },
      MediaStreams: [
        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English', IsDefault: true },
        { Index: 2, Type: 'Audio', Language: 'spa', DisplayTitle: 'Español', IsDefault: false },
        { Index: 3, Type: 'Audio', Language: 'fre', DisplayTitle: 'Français', IsDefault: false },
      ],
    } as never);
    setAudioPreference('es');

    renderPlayer('jf-item-j');
    await screen.findByTestId('pf-video');
    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(1));
    // Fire the FIRST source's own readiness checkpoint so the initial
    // Spanish-preference restore settles immediately, without needing to
    // wait out its own safety-net window too.
    hlsInstances[0].handlers.hlsManifestParsed?.();
    // Mount settles on Spanish via ONE re-resolve (saved pref differs from
    // the file's English default) - this call is NOT held pending, only the
    // manual pick below is. Wait for the SECOND hls instance too, not just
    // the call count: `toHaveBeenCalledTimes` turns true the instant the
    // mock fn is invoked (synchronously), which can win a race against
    // React actually committing the re-resolved source/DOM under load - the
    // new hls instance existing is proof the attach-source effect (and
    // therefore the new `<video>`/menu subtree) has already run.
    await vi.waitFor(() => expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(2));
    await screen.findByTestId('pf-video');

    // MANIFEST_PARSED is deliberately never fired for the SECOND source (the
    // one attached after settling on Spanish) for the rest of this
    // test - matches the "readiness never arrives" condition this whole fix
    // targets, and means `attemptInBandAudioSwitch` fails for the manual
    // pick below too (no in-band track data), forcing it down the same
    // server-round-trip fallback path production hit.
    fireEvent.click(await screen.findByRole('button', { name: 'Audio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Audio' });
    expect(within(dialog).getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');

    // The THIRD `getPlaybackInfo` call (the manual pick's own fallback,
    // Spanish -> French) stays pending on purpose - this is the exact window
    // the safety-net timer must not act in.
    let resolveManualPick: ((value: unknown) => void) | null = null;
    mockedGetPlaybackInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveManualPick = resolve;
        }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Francés' }));
    await vi.waitFor(() => expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(3));

    // Let the safety-net window (AUDIO_READINESS_FALLBACK_MS) fully elapse
    // WHILE the manual pick's own re-resolve is still unresolved. Without
    // `manualAudioPickRef`'s guard, the timer's stale read
    // (`selectedAudioIndexRef.current` still Spanish/index 2, since
    // `setSelectedAudioIndex` only runs once the pending promise above
    // resolves) mismatches the file's English default and fires a FOURTH,
    // spurious re-resolve for Spanish - the index the user just moved away
    // from.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(3);

    // Resolving it now must settle cleanly on French, with no further calls
    // (including from the NEW source's own safety-net timer, since
    // `appliedAudioIndexRef` must already read as "French, done").
    resolveManualPick?.({
      MediaSources: [
        {
          Id: 'ms-1',
          Container: 'mkv',
          TranscodingUrl: '/videos/item-j/master-manual.m3u8',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          MediaStreams: [],
        },
      ],
      PlaySessionId: 'sess-j-manual',
    });

    await vi.waitFor(() => expect(hlsInstances.length).toBeGreaterThanOrEqual(3));
    await screen.findByTestId('pf-video');
    fireEvent.click(await screen.findByRole('button', { name: 'Audio' }));
    const settledDialog = await screen.findByRole('dialog', { name: 'Audio' });
    expect(within(settledDialog).getByRole('button', { name: 'Francés' })).toHaveAttribute('aria-pressed', 'true');
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(3);
  });
});
