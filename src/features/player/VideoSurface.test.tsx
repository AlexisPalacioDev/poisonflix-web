import { createRef } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoSurface } from './VideoSurface';
import type { MediaStreamTrack } from './mediaStreamTracks';
import { __resetWordTimingsCacheForTests } from './wordTimingsSource';

// Fake `hls.js` module - jsdom has no MediaSource Extensions, so the real
// `Hls.isSupported()` always returns false in this test environment; a
// controllable fake lets both the "hls.js available" and "hls.js NOT
// available" branches be exercised deterministically.
//
// `vi.mock` factories are hoisted above every other top-level statement, so
// the class + shared state must be built inside `vi.hoisted` rather than
// referenced from an outer `const`/`class` declared later in the file (that
// would hit a TDZ error at mock-eval time).
const hoisted = vi.hoisted(() => {
  const instances: InstanceType<typeof FakeHls>[] = [];
  let supported = true;

  class FakeHls {
    static Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' } as const;
    static isSupported() {
      return supported;
    }

    handlers: Record<string, (...args: unknown[]) => void> = {};
    // The real Hls exposes this as soon as it exists (empty until a manifest
    // with multiple audio renditions is parsed). Leaving it off the double
    // made `attemptInBandAudioSwitch`'s `.audioTracks.length` throw, which is
    // a defect in the double, not in the component.
    audioTracks: { id: number }[] = [];
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();

    constructor() {
      instances.push(this);
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = cb;
    }

    emit(event: string, ...args: unknown[]) {
      this.handlers[event]?.(...args);
    }
  }

  return {
    instances,
    FakeHls,
    setSupported: (value: boolean) => {
      supported = value;
    },
  };
});

const hlsInstances = hoisted.instances;
const FakeHls = hoisted.FakeHls;

vi.mock('hls.js', () => ({ default: hoisted.FakeHls }));

function noop() {
  /* test double */
}

// New audio/subtitle track props (player spec §8) - not under test in this
// file's DirectPlay/Transcoded source-handling suites, so every render below
// gets inert defaults (no tracks, no-op handlers). Track-menu-specific
// behavior is exercised in `PlayerScreen.test.tsx` instead.
const trackMenuDefaultProps = {
  // Real-alignment word timings (`wordTimingsSource.ts`) fetch keyed on this
  // - a fixed, inert id is fine for every suite in this file that isn't
  // exercising that fetch directly (its own describe block below stubs
  // `fetch` and overrides `itemId` where it matters).
  itemId: 'item-1',
  audioTracks: [],
  subtitleTracks: [],
  selectedAudioIndex: null,
  selectedSubtitleIndex: null,
  onAudioApplied: noop,
  onAudioSwitchUnavailable: noop,
  onSubtitleApplied: noop,
  // Second, SIMULTANEOUS subtitle (owner request - dual subtitles, this
  // file's own "Dual subtitles" header section). `null`/no-op by default -
  // exercised explicitly in its own describe block further down.
  selectedSecondSubtitleIndex: null,
  onSecondSubtitleApplied: noop,
  // Per-index DeliveryMethod for the CURRENT resolved source's subtitle
  // MediaStreams (player spec: burned-in subtitle dedup bug fix) - empty by
  // default, matching a DirectPlay/no-transcode session where nothing is
  // server-burned. `onSubtitleSwitchUnavailable` mirrors
  // `onAudioSwitchUnavailable`: fired instead of a purely client-side toggle
  // when the active source has ANYTHING burned in (switching away needs a
  // fresh PlaybackInfo re-resolve, not just hiding a `<track>`).
  subtitleDeliveryMethods: {},
  onSubtitleSwitchUnavailable: noop,
  buildSubtitleUrl: () => '',
  // Episode prev/next/jump navigation (player spec: only for `Episode`
  // items) - inert defaults for every suite in this file that isn't
  // exercising it directly (mirrors trackMenuDefaultProps' own reasoning).
  isEpisode: false,
  episodes: [],
  currentEpisodeId: '',
  onSelectEpisode: noop,
};

const directPlaySource = { kind: 'DirectPlay' as const, url: '/jellyfin/Videos/item-1/stream.mp4' };
const transcodedSource = { kind: 'Transcoded' as const, hlsUrl: '/jellyfin/videos/item-1/master.m3u8' };

afterEach(() => {
  hlsInstances.length = 0;
  hoisted.setSupported(true);
  vi.clearAllMocks();
  // Every render in this file shares `trackMenuDefaultProps.itemId`
  // ('item-1'), and `fetchWordTimingsData` (`wordTimingsSource.ts`) caches
  // its promise PER ITEM at module scope - without this reset, whichever
  // test renders first "wins" that item's cached (real-`fetch`-rejected,
  // since most suites here never stub `fetch`) result for every later test
  // in the same file, including the ones below that deliberately stub
  // `fetch` to test different word-timings outcomes for that same id.
  __resetWordTimingsCacheForTests();
});

describe('VideoSurface — DirectPlay (player spec: "Resume seek on ready")', () => {
  it('seeks to the resume position exactly once, after loadedmetadata fires', () => {
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={directPlaySource}
        resumeSeconds={42}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    expect(video.currentTime).toBe(0);

    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42);

    // Simulate the user seeking elsewhere afterwards - a second ready-style
    // event (canplay) must NOT re-apply the resume seek and clobber it.
    video.currentTime = 999;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(999);
  });

  it('does not seek at all when resumeSeconds is 0 (no resume position)', () => {
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={{ kind: 'DirectPlay', url: '/jellyfin/Videos/item-2/stream.mp4' }}
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(0);
  });

  it('resets the resume-seek guard when the source changes (a second, different video)', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const { rerender } = render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={{ kind: 'DirectPlay', url: '/jellyfin/Videos/item-1/stream.mp4' }}
        resumeSeconds={10}
        title="First movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(10);

    rerender(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={{ kind: 'DirectPlay', url: '/jellyfin/Videos/item-2/stream.mp4' }}
        resumeSeconds={77}
        title="Second movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(77);
  });

  it('calls onPlay/onPause/onEnded when the underlying video fires those events', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const onEnded = vi.fn();

    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={directPlaySource}
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.play(video);
    fireEvent.pause(video);
    fireEvent.ended(video);

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('sets video.src directly to the DirectPlay url (no hls.js instance created)', () => {
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={directPlaySource}
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    expect(video.src).toContain('/jellyfin/Videos/item-1/stream.mp4');
    expect(hlsInstances).toHaveLength(0);
  });
});

describe('VideoSurface — Transcoded (hls.js seam, design.md §10)', () => {
  it('loads the HLS source via hls.js and resume-seeks only after MANIFEST_PARSED, not loadedmetadata', () => {
    hoisted.setSupported(true);
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={transcodedSource}
        resumeSeconds={30}
        title="Transcoded movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    expect(hlsInstances).toHaveLength(1);
    const hls = hlsInstances[0];
    expect(hls.loadSource).toHaveBeenCalledWith(transcodedSource.hlsUrl);
    expect(hls.attachMedia).toHaveBeenCalledWith(video);

    // The gotcha: loadedmetadata must NOT apply the resume seek for a
    // Transcoded source.
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);

    // Only MANIFEST_PARSED (hls.js's own ready event) applies it.
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    expect(video.currentTime).toBe(30);
  });

  it('destroys the hls.js instance on unmount and on source change', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const { rerender, unmount } = render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={transcodedSource}
        resumeSeconds={0}
        title="Transcoded movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const firstInstance = hlsInstances[0];
    expect(firstInstance.destroy).not.toHaveBeenCalled();

    rerender(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={{ kind: 'Transcoded', hlsUrl: '/jellyfin/videos/item-2/master.m3u8' }}
        resumeSeconds={0}
        title="Another transcoded movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1);

    const secondInstance = hlsInstances[1];
    unmount();
    expect(secondInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it('calls onError when hls.js reports a fatal error', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const onError = vi.fn();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={transcodedSource}
        resumeSeconds={0}
        title="Transcoded movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={onError}
        onUnsupported={noop}
      />,
    );

    const hls = hlsInstances[0];
    hls.emit(FakeHls.Events.ERROR, {}, { fatal: false });
    expect(onError).not.toHaveBeenCalled();
    hls.emit(FakeHls.Events.ERROR, {}, { fatal: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('calls onUnsupported when hls.js is unsupported and there is no native HLS (jsdom has neither)', () => {
    hoisted.setSupported(false);
    const videoRef = createRef<HTMLVideoElement>();
    const onUnsupported = vi.fn();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={transcodedSource}
        resumeSeconds={0}
        title="Transcoded movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={onUnsupported}
      />,
    );

    expect(hlsInstances).toHaveLength(0);
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });
});

// Bug fix: DeliveryMethod: 'Encode' means Jellyfin already burned the
// subtitle into the transcoded video's PIXELS (live evidence: Solo Leveling
// S02E02, PlaybackInfo returned `{ Index: 2, Codec: 'ass', DeliveryMethod:
// 'Encode' }`; the ORIGINAL file has no burned-in text at t=117s - confirmed
// via ffmpeg frame extraction). Mounting a client-side <track> (or hls.js
// text rendition) for that SAME stream on top doubles the same text on
// screen. The client must never do that for an Encode-delivered stream, even
// though it stays the SELECTED entry in the track menu (the user IS
// effectively watching it - it's just not the client's job to render it).
describe('VideoSurface — burned-in subtitles (DeliveryMethod: "Encode") must not double-render (bug fix)', () => {
  const burnedInTrack: MediaStreamTrack = {
    index: 2,
    kind: 'Subtitle',
    language: 'fra',
    displayTitle: 'Français',
    isDefault: false,
    isForced: false,
  };
  const normalTrack: MediaStreamTrack = {
    index: 3,
    kind: 'Subtitle',
    language: 'spa',
    displayTitle: 'Español',
    isDefault: false,
    isForced: false,
  };

  it('mounts no client-side <track> for a subtitle whose DeliveryMethod is "Encode", even though it is the SELECTED index', () => {
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[burnedInTrack]}
        selectedSubtitleIndex={burnedInTrack.index}
        subtitleDeliveryMethods={{ [burnedInTrack.index]: 'Encode' }}
        buildSubtitleUrl={() => '/jellyfin/Videos/item-1/ms-1/Subtitles/2/Stream.vtt'}
        source={transcodedSource}
        resumeSeconds={0}
        title="Solo Leveling S02E02"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    expect(video.querySelectorAll('track')).toHaveLength(0);
  });

  it('still mounts + shows a NORMAL (non-Encode) subtitle track normally, next to a burned-in one', () => {
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[burnedInTrack, normalTrack]}
        selectedSubtitleIndex={normalTrack.index}
        subtitleDeliveryMethods={{ [burnedInTrack.index]: 'Encode', [normalTrack.index]: 'External' }}
        buildSubtitleUrl={(track) => `/jellyfin/Videos/item-1/ms-1/Subtitles/${track.index}/Stream.vtt`}
        source={transcodedSource}
        resumeSeconds={0}
        title="Solo Leveling S02E02"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    const tracks = video.querySelectorAll('track');
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toHaveAttribute('srclang', 'spa');
  });
});

describe('VideoSurface — episode prev/next/jump navigation (owner request)', () => {
  // `imageTag: null` = no still frame; the menu falls back to a text-only row.
  const s1e1 = { id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot', imageTag: null };
  const s1e2 = { id: 'ep-2', seasonNumber: 1, episodeNumber: 2, title: 'Second', imageTag: null };
  const s2e1 = { id: 'ep-3', seasonNumber: 2, episodeNumber: 1, title: 'Return', imageTag: null };
  const episodes = [s1e1, s1e2, s2e1];

  function renderSurface(overrides: Partial<Parameters<typeof VideoSurface>[0]> = {}) {
    const videoRef = createRef<HTMLVideoElement>();
    return render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={directPlaySource}
        resumeSeconds={0}
        title="Some episode"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
        {...overrides}
      />,
    );
  }

  it('a movie (isEpisode: false) renders none of the three controls', () => {
    renderSurface({ isEpisode: false, episodes, currentEpisodeId: s1e1.id });

    expect(screen.queryByRole('button', { name: 'Episodio anterior' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Episodio siguiente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Episodios' })).not.toBeInTheDocument();
  });

  it('an episode renders all three controls', () => {
    renderSurface({ isEpisode: true, episodes, currentEpisodeId: s1e1.id });

    expect(screen.getByRole('button', { name: 'Episodio anterior' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Episodio siguiente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Episodios' })).toBeInTheDocument();
  });

  it('disables "Episodios" while the list is still loading (empty), instead of opening an empty dialog', () => {
    renderSurface({ isEpisode: true, episodes: [], currentEpisodeId: s1e1.id });
    expect(screen.getByRole('button', { name: 'Episodios' })).toBeDisabled();
  });

  it('disables "anterior" on the first episode and "siguiente" on the last', () => {
    const { unmount } = renderSurface({ isEpisode: true, episodes, currentEpisodeId: s1e1.id });
    expect(screen.getByRole('button', { name: 'Episodio anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Episodio siguiente' })).not.toBeDisabled();
    unmount();

    renderSurface({ isEpisode: true, episodes, currentEpisodeId: s2e1.id });
    expect(screen.getByRole('button', { name: 'Episodio anterior' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Episodio siguiente' })).toBeDisabled();
  });

  it('"siguiente" crosses a season boundary: last of S1 -> first of S2', () => {
    const onSelectEpisode = vi.fn();
    renderSurface({ isEpisode: true, episodes, currentEpisodeId: s1e2.id, onSelectEpisode });

    fireEvent.click(screen.getByRole('button', { name: 'Episodio siguiente' }));
    expect(onSelectEpisode).toHaveBeenCalledWith(s2e1.id);
  });

  it('"anterior" navigates to the previous episode id', () => {
    const onSelectEpisode = vi.fn();
    renderSurface({ isEpisode: true, episodes, currentEpisodeId: s1e2.id, onSelectEpisode });

    fireEvent.click(screen.getByRole('button', { name: 'Episodio anterior' }));
    expect(onSelectEpisode).toHaveBeenCalledWith(s1e1.id);
  });

  it('the episode menu lists every episode, marks the current one, and selecting closes it and navigates', () => {
    const onSelectEpisode = vi.fn();
    renderSurface({ isEpisode: true, episodes, currentEpisodeId: s1e2.id, onSelectEpisode });

    fireEvent.click(screen.getByRole('button', { name: 'Episodios' }));
    const dialog = screen.getByRole('dialog', { name: 'Episodios' });

    const current = within(dialog).getByRole('button', { name: /T1 E2/ });
    expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: /T1 E1/ })).toHaveAttribute('aria-pressed', 'false');
    expect(within(dialog).getByRole('button', { name: /T2 E1/ })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /T2 E1/ }));

    expect(onSelectEpisode).toHaveBeenCalledWith(s2e1.id);
    expect(screen.queryByRole('dialog', { name: 'Episodios' })).not.toBeInTheDocument();
  });
});

// Dual subtitles (owner request, verbatim: "me gustaría mucho tener 2
// subtítulos al tiempo, ejemplo inglés y español, porque mi intención es
// aprender inglés" - a language-learning feature, not accessibility). See
// this file's "Dual subtitles" header section for the full design rationale
// (why a custom overlay + our own VTT fetch/parse instead of two `<track>`
// elements). Word-by-word highlighting (its own describe block further
// below) is layered on TOP of this same overlay - these tests below predate
// it and exercise the plain-text rendering path, which stays exactly as it
// was (word highlight only kicks in for an eligible English row - see
// `subtitleCues.ts`'s header).
describe('VideoSurface — dual subtitles (owner request: read two languages at once)', () => {
  const englishTrack: MediaStreamTrack = {
    index: 1,
    kind: 'Subtitle',
    language: 'eng',
    displayTitle: 'English',
    isDefault: false,
    isForced: false,
  };
  const spanishTrack: MediaStreamTrack = {
    index: 2,
    kind: 'Subtitle',
    language: 'spa',
    displayTitle: 'Español',
    isDefault: false,
    isForced: false,
  };

  const englishVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there.\n';
  const spanishVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHola.\n';

  // Also receives the `wordTimingsSource.ts` fetch (`/updates/wordtimings/...`)
  // - it falls into the `''` branch below, which this test double has no
  // `.ok`/`.json()` for, so `fetchWordTimingsData` treats it as "no data" and
  // falls back to the estimate, same as a real 404 would. That's WHY every
  // `waitFor(... toHaveBeenCalledTimes(...))` below counts 3, not 2: the two
  // VTT fetches PLUS this one, all through the SAME stubbed global `fetch`.
  function fetchResponseFor(url: string): Promise<Response> {
    const text = url.includes('/subs/1') ? englishVtt : url.includes('/subs/2') ? spanishVtt : '';
    return Promise.resolve({ text: () => Promise.resolve(text) } as Response);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders BOTH languages at once - English on top, Spanish below - once a second subtitle is selected', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => fetchResponseFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    const { rerender } = render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={null}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Backrooms: Sin salida"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    // Establishes the SINGLE-subtitle baseline first (this is the existing,
    // unchanged path - `onCanPlay` is DirectPlay's readiness checkpoint for
    // `applyCurrentSubtitleSelection`, same as every other test in this
    // file): the native `<track>` for English is showing, exactly as before
    // dual subtitles existed.
    fireEvent.canPlay(video);
    const tracks = video.querySelectorAll('track');
    expect(tracks).toHaveLength(2);
    const englishTrackEl = Array.from(tracks).find((t) => t.getAttribute('srclang') === 'eng') as HTMLTrackElement;
    expect(englishTrackEl.track?.mode).toBe('showing');

    // Turning the second subtitle ON activates dual mode: BOTH native
    // `<track>`s must be forced back to 'disabled' - otherwise the browser
    // would ALSO paint English natively underneath our own overlay,
    // doubling it (this file's header: the exact failure shape the burned-in
    // dedup fix already prevents once).
    rerender(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={spanishTrack.index}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Backrooms: Sin salida"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(englishTrackEl.track?.mode).toBe('disabled');

    // Land the video's clock inside both cues' [1s, 3s) window and let the
    // overlay pick up the active line - the SAME `currentTime` state this
    // file already updates on every `timeupdate`, no extra listener.
    Object.defineProperty(video, 'currentTime', { value: 1.5, configurable: true });
    fireEvent.timeUpdate(video);

    // Checked via `.textContent` rather than `screen.getByText` - the
    // English row's word-level highlight (own describe block below) wraps
    // each word in its own `<span>`, so "Hello there." is no longer a SINGLE
    // text node RTL's default text matcher would find; the full rendered
    // sentence is still what matters here, not its internal markup.
    await waitFor(() => {
      expect(document.querySelector('.pf-player-surface__subtitle-line--primary')?.textContent).toBe(
        'Hello there.',
      );
    });
    expect(document.querySelector('.pf-player-surface__subtitle-line--second')?.textContent).toBe('Hola.');
  });

  it('leaves single-subtitle mode completely unchanged when no second subtitle is selected', () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => fetchResponseFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={null}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Backrooms: Sin salida"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);

    const tracks = video.querySelectorAll('track');
    const englishTrackEl = Array.from(tracks).find((t) => t.getAttribute('srclang') === 'eng') as HTMLTrackElement;
    expect(englishTrackEl.track?.mode).toBe('showing');
    // No dual overlay, and the dual-subtitle VTT-fetch effect never runs -
    // the second slot being `null` is a structural no-op, not merely an
    // empty render. The word-timings fetch (`wordTimingsSource.ts`) DOES
    // still fire - it's unconditional on every item open, independent of
    // dual-subtitle mode - so it's the only call, not zero.
    expect(document.querySelector('.pf-player-surface__dual-subtitles')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/updates/wordtimings/item-1.json');
  });

  it('a pair with one Encode-delivered ("burned in") track is blocked, not silently broken', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => fetchResponseFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={spanishTrack.index}
        // Spanish (the SECOND slot) is server-burned into the video's
        // pixels for this resolved source - there is no independent text
        // for the overlay to fetch, so dual rendering must not activate.
        subtitleDeliveryMethods={{ [spanishTrack.index]: 'Encode' }}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Backrooms: Sin salida"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);

    // No crash, no overlay, no wasted DUAL-SUBTITLE fetch - and the PRIMARY
    // (non-burned) subtitle keeps rendering exactly like single-subtitle mode
    // always did. The word-timings fetch still fires regardless (see the
    // previous test's comment) - it's the only call.
    expect(document.querySelector('.pf-player-surface__dual-subtitles')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/updates/wordtimings/item-1.json');
    const tracks = video.querySelectorAll('track');
    const englishTrackEl = Array.from(tracks).find((t) => t.getAttribute('srclang') === 'eng') as HTMLTrackElement;
    expect(englishTrackEl.track?.mode).toBe('showing');
  });

  it('a failed VTT fetch does not crash playback - falls back to no overlay text', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={spanishTrack.index}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Backrooms: Sin salida"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // The overlay container still mounts (dual mode IS selected/valid), it
    // just has no active line to show - never a thrown error or a blank
    // white-screen.
    const overlay = document.querySelector('.pf-player-surface__dual-subtitles');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('p')).toHaveLength(0);
  });
});

// Word-level highlight (owner request, verbatim: "resaltar la palabra que se
// está pronunciando" - follow the English audio with your eyes while it
// plays). English row only - see `subtitleCues.ts`'s header for why the
// Spanish row never gets word-by-word markup (it's a translation, not a
// transcription).
describe('VideoSurface — word-level highlight (owner request: follow the English audio with your eyes)', () => {
  const englishTrack: MediaStreamTrack = {
    index: 1,
    kind: 'Subtitle',
    language: 'eng',
    displayTitle: 'English',
    isDefault: false,
    isForced: false,
  };
  const spanishTrack: MediaStreamTrack = {
    index: 2,
    kind: 'Subtitle',
    language: 'spa',
    displayTitle: 'Español',
    isDefault: false,
    isForced: false,
  };

  // A single 4-second cue with three words - long enough that 0.1s and 3.9s
  // land on clearly DIFFERENT words (see `subtitleCues.test.ts`'s own
  // `estimateWordTimings` tests for the exact per-word math).
  const englishVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nHi there friend\n';
  const spanishVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nHola amigo\n';

  // Also receives the `wordTimingsSource.ts` fetch (`/updates/wordtimings/...`)
  // - it falls into the `''` branch below, which this test double has no
  // `.ok`/`.json()` for, so `fetchWordTimingsData` treats it as "no data" and
  // falls back to the estimate, same as a real 404 would. That's WHY every
  // `waitFor(... toHaveBeenCalledTimes(...))` below counts 3, not 2: the two
  // VTT fetches PLUS this one, all through the SAME stubbed global `fetch`.
  function fetchResponseFor(url: string): Promise<Response> {
    const text = url.includes('/subs/1') ? englishVtt : url.includes('/subs/2') ? spanishVtt : '';
    return Promise.resolve({ text: () => Promise.resolve(text) } as Response);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    // The toggle persists via localStorage (playerPrefs.ts) - must not leak
    // an explicit "off" pick into the next test, which expects the default.
    localStorage.clear();
  });

  function renderDual() {
    const fetchMock = vi.fn().mockImplementation((url: string) => fetchResponseFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={spanishTrack.index}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Balls Up"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );
    return fetchMock;
  }

  it('renders the English row as per-word spans, and the Spanish row as plain text (never word-by-word)', async () => {
    const fetchMock = renderDual();
    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
    fireEvent.timeUpdate(video);

    const overlay = document.querySelector('.pf-player-surface__dual-subtitles');
    const primaryLine = overlay?.querySelector('.pf-player-surface__subtitle-line--primary');
    const secondLine = overlay?.querySelector('.pf-player-surface__subtitle-line--second');

    expect(primaryLine?.querySelectorAll('.pf-player-surface__word')).toHaveLength(3);
    expect(secondLine?.querySelectorAll('.pf-player-surface__word')).toHaveLength(0);
    expect(secondLine?.textContent).toBe('Hola amigo');
  });

  it('the highlighted word ADVANCES to a different word as playback time moves forward', async () => {
    const fetchMock = renderDual();
    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const primaryLine = () => document.querySelector('.pf-player-surface__subtitle-line--primary');
    const currentWordText = () => primaryLine()?.querySelector('.pf-player-surface__word--current')?.textContent;

    Object.defineProperty(video, 'currentTime', { value: 0.1, configurable: true });
    fireEvent.timeUpdate(video);
    const earlyWord = currentWordText();
    expect(earlyWord).toBeTruthy();

    Object.defineProperty(video, 'currentTime', { value: 3.9, configurable: true });
    fireEvent.timeUpdate(video);
    const lateWord = currentWordText();

    expect(lateWord).toBeTruthy();
    expect(lateWord).not.toBe(earlyWord);
  });

  it('stays OFF when the saved preference is off - the English row renders as plain text too', async () => {
    localStorage.setItem('poisonflix:wordHighlightPreference', '0');
    const fetchMock = renderDual();
    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
    fireEvent.timeUpdate(video);

    expect(document.querySelectorAll('.pf-player-surface__word')).toHaveLength(0);
    expect(screen.getByText('Hi there friend')).toBeInTheDocument();
  });

  it('the "Subtítulos" menu offers a toggle, and turning it off removes the per-word spans live', async () => {
    const fetchMock = renderDual();
    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
    fireEvent.timeUpdate(video);
    expect(document.querySelectorAll('.pf-player-surface__word').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Subtítulos' }));
    fireEvent.click(
      screen.getByRole('button', { name: /Resaltar la palabra que se está pronunciando/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));

    expect(document.querySelectorAll('.pf-player-surface__word')).toHaveLength(0);
  });

  // Coverage gap flagged by the challenger audit: every test above put
  // English in the PRIMARY slot. `VideoSurface.tsx` checks
  // `languageFamily(...) === 'en'` independently for `primaryDualTrack` AND
  // `secondDualTrack` - this exercises the second slot's own check, not just
  // the primary's.
  it('highlights the SECOND row when English is the second subtitle instead of the primary', async () => {
    // englishTrack.index === 1, spanishTrack.index === 2 (this describe
    // block's shared fixtures) - the URL built for each track embeds ITS
    // OWN index, regardless of which slot (primary/second) it's assigned to.
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ text: () => Promise.resolve(url.includes('/subs/1') ? englishVtt : spanishVtt) } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[spanishTrack, englishTrack]}
        selectedSubtitleIndex={spanishTrack.index}
        selectedSecondSubtitleIndex={englishTrack.index}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Balls Up"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
    fireEvent.timeUpdate(video);

    const overlay = document.querySelector('.pf-player-surface__dual-subtitles');
    const primaryLine = overlay?.querySelector('.pf-player-surface__subtitle-line--primary');
    const secondLine = overlay?.querySelector('.pf-player-surface__subtitle-line--second');

    expect(primaryLine?.querySelectorAll('.pf-player-surface__word')).toHaveLength(0);
    expect(primaryLine?.textContent).toBe('Hola amigo');
    expect(secondLine?.querySelectorAll('.pf-player-surface__word')).toHaveLength(3);
  });

  it('highlights NEITHER row when neither dual-subtitle language is English', async () => {
    const frenchTrack: MediaStreamTrack = {
      index: 3,
      kind: 'Subtitle',
      language: 'fra',
      displayTitle: 'Français',
      isDefault: false,
      isForced: false,
    };
    const frenchVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nBonjour ami\n';
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ text: () => Promise.resolve(url.includes('/subs/2') ? spanishVtt : frenchVtt) } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[frenchTrack, spanishTrack]}
        selectedSubtitleIndex={frenchTrack.index}
        selectedSecondSubtitleIndex={spanishTrack.index}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Balls Up"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
    fireEvent.timeUpdate(video);

    // Not just "no spans anywhere" (which would pass even if the overlay
    // rendered nothing at all) - both rows must still show their plain text,
    // proving dual mode DID activate and simply chose not to highlight it.
    expect(document.querySelectorAll('.pf-player-surface__word')).toHaveLength(0);
    expect(document.querySelector('.pf-player-surface__subtitle-line--primary')?.textContent).toBe('Bonjour ami');
    expect(document.querySelector('.pf-player-surface__subtitle-line--second')?.textContent).toBe('Hola amigo');
  });

  it('clicking the toggle WRITES the new value to localStorage, not just component state', async () => {
    const fetchMock = renderDual();
    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(localStorage.getItem('poisonflix:wordHighlightPreference')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Subtítulos' }));
    fireEvent.click(
      screen.getByRole('button', { name: /Resaltar la palabra que se está pronunciando/ }),
    );

    expect(localStorage.getItem('poisonflix:wordHighlightPreference')).toBe('0');
  });

  it('the said/current/upcoming ladder is assigned correctly across ALL words, not just the current one', async () => {
    // A 4-word cue so there's at least one word on each side of "current".
    const fourWordVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nAlpha bravo charlie delta\n';
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ text: () => Promise.resolve(url.includes('/subs/1') ? fourWordVtt : spanishVtt) } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        subtitleTracks={[englishTrack, spanishTrack]}
        selectedSubtitleIndex={englishTrack.index}
        selectedSecondSubtitleIndex={spanishTrack.index}
        buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
        source={directPlaySource}
        resumeSeconds={0}
        title="Balls Up"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // Four equal-ish-weight words over 4s land roughly one per second -
    // landing at 2s should be on word 3 ("charlie"), with two words already
    // said and one still upcoming.
    Object.defineProperty(video, 'currentTime', { value: 2, configurable: true });
    fireEvent.timeUpdate(video);

    const primaryLine = document.querySelector('.pf-player-surface__subtitle-line--primary');
    const words = Array.from(primaryLine?.querySelectorAll('.pf-player-surface__word') ?? []);
    expect(words.map((w) => w.textContent)).toEqual(['Alpha', 'bravo', 'charlie', 'delta']);
    expect(words[0]).toHaveClass('pf-player-surface__word--said');
    expect(words[1]).toHaveClass('pf-player-surface__word--said');
    expect(words[2]).toHaveClass('pf-player-surface__word--current');
    expect(words[3]).toHaveClass('pf-player-surface__word--upcoming');
  });

  // Real alignment data (`wordTimingsSource.ts`, VideoSurface.tsx's "Real
  // alignment data" header section) - proving the WIRING, not the matching
  // logic itself (that's `wordTimingsSource.test.ts`'s job). Reuses
  // `englishTrack`/`spanishTrack`/`englishVtt`/`spanishVtt` from this
  // describe block: `englishVtt` is the same single 4s "Hi there friend" cue,
  // so its ESTIMATE boundaries are already known (see the "ADVANCES" test
  // above / `subtitleCues.test.ts`) - under the estimate, `Hi` (weight 3,
  // floored) owns [0, 0.857s), so 0.6s lands on `Hi`; a real-data file that
  // instead puts word 0 at [0, 500ms) and word 1 ("there") at [500ms, 1000ms)
  // makes 0.6s land on `there` instead - an unambiguous signal of WHICH
  // source actually drove the render.
  describe('real alignment data (wordTimingsSource.ts) - wiring into WordHighlightedLine', () => {
    const itemId = 'item-1'; // trackMenuDefaultProps' own default - kept explicit here since the payload's `item` must match it.

    function fetchResponseForWithWordTimings(wordTimingsResponse: () => Promise<Response>) {
      return (url: string): Promise<Response> => {
        if (url.includes('/updates/wordtimings/')) return wordTimingsResponse();
        return fetchResponseFor(url);
      };
    }

    function renderDualWithWordTimings(wordTimingsResponse: () => Promise<Response>) {
      const fetchMock = vi.fn().mockImplementation(fetchResponseForWithWordTimings(wordTimingsResponse));
      vi.stubGlobal('fetch', fetchMock);

      const videoRef = createRef<HTMLVideoElement>();
      render(
        <VideoSurface
          videoRef={videoRef}
          {...trackMenuDefaultProps}
          itemId={itemId}
          subtitleTracks={[englishTrack, spanishTrack]}
          selectedSubtitleIndex={englishTrack.index}
          selectedSecondSubtitleIndex={spanishTrack.index}
          buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
          source={directPlaySource}
          resumeSeconds={0}
          title="Balls Up"
          onBack={noop}
          onPlay={noop}
          onPause={noop}
          onEnded={noop}
          onError={noop}
          onUnsupported={noop}
        />,
      );
      return fetchMock;
    }

    async function currentWordAt(fetchMock: ReturnType<typeof vi.fn>, currentTimeSeconds: number): Promise<string | null | undefined> {
      const video = screen.getByTestId('pf-video') as HTMLVideoElement;
      fireEvent.canPlay(video);
      // 2 sideloaded-VTT fetches (English + Spanish) + 1 word-timings fetch.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      Object.defineProperty(video, 'currentTime', { value: currentTimeSeconds, configurable: true });
      fireEvent.timeUpdate(video);

      const primaryLine = document.querySelector('.pf-player-surface__subtitle-line--primary');
      return primaryLine?.querySelector('.pf-player-surface__word--current')?.textContent;
    }

    it('uses the REAL per-word timings from the fetched file, when it covers this exact cue and track', async () => {
      const fetchMock = renderDualWithWordTimings(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              v: 1,
              item: itemId,
              track: englishTrack.index,
              cues: [{ t: 0, w: [[0, 500], [500, 1000], [1000, 4000]] }],
            }),
        } as Response),
      );

      expect(await currentWordAt(fetchMock, 0.6)).toBe('there'); // real data's word boundary, NOT the estimate's
    });

    it('falls back to the estimate when the file is for a DIFFERENT subtitle track than the one selected', async () => {
      const fetchMock = renderDualWithWordTimings(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              v: 1,
              item: itemId,
              track: 99, // not englishTrack.index
              cues: [{ t: 0, w: [[0, 500], [500, 1000], [1000, 4000]] }],
            }),
        } as Response),
      );

      expect(await currentWordAt(fetchMock, 0.6)).toBe('Hi'); // estimate's word boundary
    });

    it('falls back to the estimate when the matched cue\'s word count does not equal the current subtitle\'s word count', async () => {
      const fetchMock = renderDualWithWordTimings(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              v: 1,
              item: itemId,
              track: englishTrack.index,
              cues: [{ t: 0, w: [[0, 2000], [2000, 4000]] }], // 2 entries, cue has 3 words
            }),
        } as Response),
      );

      expect(await currentWordAt(fetchMock, 0.6)).toBe('Hi'); // estimate's word boundary
    });

    it('keeps working off the estimate when the word-timings file 404s - the normal case for most titles', async () => {
      const fetchMock = renderDualWithWordTimings(() => Promise.resolve({ ok: false, status: 404 } as Response));

      expect(await currentWordAt(fetchMock, 0.6)).toBe('Hi'); // estimate's word boundary - never blocked, never crashed
    });

    // Challenger-audit gap: every test above puts English (and therefore the
    // real-data track match) in the PRIMARY slot. `WordHighlightedLine`'s two
    // call sites in VideoSurface.tsx each pass their OWN track's index
    // (`primaryDualTrack?.index` / `secondDualTrack?.index`) - this exercises
    // the SECOND call site specifically, so a copy-paste of the primary's
    // index into the second slot (or vice versa) would fail this test even
    // though every test above would stay green.
    it('applies real data to the SECOND row using ITS OWN track index, when English is the second subtitle', async () => {
      // englishTrack.index === 1, spanishTrack.index === 2 (this describe
      // block's outer fixtures). Spanish is primary, English is second.
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/updates/wordtimings/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                v: 1,
                item: itemId,
                track: englishTrack.index, // matches the SECOND row's track, not the primary's (spanishTrack)
                cues: [{ t: 0, w: [[0, 500], [500, 1000], [1000, 4000]] }],
              }),
          } as Response);
        }
        return fetchResponseFor(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const videoRef = createRef<HTMLVideoElement>();
      render(
        <VideoSurface
          videoRef={videoRef}
          {...trackMenuDefaultProps}
          itemId={itemId}
          subtitleTracks={[spanishTrack, englishTrack]}
          selectedSubtitleIndex={spanishTrack.index}
          selectedSecondSubtitleIndex={englishTrack.index}
          buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
          source={directPlaySource}
          resumeSeconds={0}
          title="Balls Up"
          onBack={noop}
          onPlay={noop}
          onPause={noop}
          onEnded={noop}
          onError={noop}
          onUnsupported={noop}
        />,
      );

      const video = screen.getByTestId('pf-video') as HTMLVideoElement;
      fireEvent.canPlay(video);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      Object.defineProperty(video, 'currentTime', { value: 0.6, configurable: true });
      fireEvent.timeUpdate(video);

      const secondLine = document.querySelector('.pf-player-surface__subtitle-line--second');
      expect(secondLine?.querySelector('.pf-player-surface__word--current')?.textContent).toBe('there'); // real data's boundary, not the estimate's
    });

    // Challenger-audit gap: `wordTimingsFile` resets to `null` on every
    // `itemId` change (VideoSurface.tsx) so a NEW item never transiently
    // renders using the OLD item's real data while its own fetch is still in
    // flight - PlayerScreen does not remount VideoSurface on an item change
    // (`usePlaybackHeartbeat.ts`'s own header), so this reset is the only
    // thing preventing that. Proven here by never letting item B's fetch
    // resolve at all: if the reset were missing/broken, item A's real data
    // would still be showing.
    it('stops using the OLD item\'s real data as soon as itemId changes, even before the NEW item\'s fetch resolves', async () => {
      let resolveItemB: ((response: Response) => void) | undefined;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/updates/wordtimings/item-1.json')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                v: 1,
                item: 'item-1',
                track: englishTrack.index,
                cues: [{ t: 0, w: [[0, 500], [500, 1000], [1000, 4000]] }],
              }),
          } as Response);
        }
        if (url.includes('/updates/wordtimings/item-2.json')) {
          // Deliberately never resolves within this test - proves the reset
          // does not depend on item B's fetch settling.
          return new Promise<Response>((resolve) => {
            resolveItemB = resolve;
          });
        }
        return fetchResponseFor(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const videoRef = createRef<HTMLVideoElement>();
      const { rerender } = render(
        <VideoSurface
          videoRef={videoRef}
          {...trackMenuDefaultProps}
          itemId="item-1"
          subtitleTracks={[englishTrack, spanishTrack]}
          selectedSubtitleIndex={englishTrack.index}
          selectedSecondSubtitleIndex={spanishTrack.index}
          buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
          source={directPlaySource}
          resumeSeconds={0}
          title="Balls Up"
          onBack={noop}
          onPlay={noop}
          onPause={noop}
          onEnded={noop}
          onError={noop}
          onUnsupported={noop}
        />,
      );

      const video = screen.getByTestId('pf-video') as HTMLVideoElement;
      fireEvent.canPlay(video);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      Object.defineProperty(video, 'currentTime', { value: 0.6, configurable: true });
      fireEvent.timeUpdate(video);
      expect(document.querySelector('.pf-player-surface__word--current')?.textContent).toBe('there'); // item-1's real data, confirmed applied

      // Same track/cue text, but a NEW item whose word-timings fetch is
      // deliberately left pending (see `resolveItemB`, never called).
      rerender(
        <VideoSurface
          videoRef={videoRef}
          {...trackMenuDefaultProps}
          itemId="item-2"
          subtitleTracks={[englishTrack, spanishTrack]}
          selectedSubtitleIndex={englishTrack.index}
          selectedSecondSubtitleIndex={spanishTrack.index}
          buildSubtitleUrl={(track) => `/jellyfin/subs/${track.index}/Stream.vtt`}
          source={directPlaySource}
          resumeSeconds={0}
          title="Balls Up"
          onBack={noop}
          onPlay={noop}
          onPause={noop}
          onEnded={noop}
          onError={noop}
          onUnsupported={noop}
        />,
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/updates/wordtimings/item-2.json'));

      Object.defineProperty(video, 'currentTime', { value: 0.6, configurable: true });
      fireEvent.timeUpdate(video);
      // Item-1's real data must NOT still be applied to item-2's (identical
      // text) cue - falls back to the estimate's boundary instead.
      expect(document.querySelector('.pf-player-surface__word--current')?.textContent).toBe('Hi');

      expect(resolveItemB).toBeDefined(); // sanity: item-2's fetch really was still pending, not accidentally settled
    });
  });
});

// The owner's "changing windows restarts the movie" report, fixed at the
// mechanism rather than at one trigger. `usePlaybackInfo` no longer refetches
// on focus, but the fragility underneath was that ANY re-resolve reopened
// playback: the component identified a playback by its full stream URL, and
// Jellyfin puts a freshly-minted PlaySessionId in every one of those.
describe('VideoSurface — a re-resolved source is not automatically a new playback', () => {
  const withSession = (session: string, audioIndex = 1) => ({
    kind: 'Transcoded' as const,
    hlsUrl: `/jellyfin/videos/item-1/master.m3u8?AudioStreamIndex=${audioIndex}&PlaySessionId=${session}`,
  });

  function renderWith(source: { kind: 'Transcoded'; hlsUrl: string }) {
    const videoRef = createRef<HTMLVideoElement>();
    const utils = render(
      <VideoSurface
        videoRef={videoRef}
        {...trackMenuDefaultProps}
        source={source}
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );
    const rerenderWith = (next: { kind: 'Transcoded'; hlsUrl: string }) =>
      utils.rerender(
        <VideoSurface
          videoRef={videoRef}
          {...trackMenuDefaultProps}
          source={next}
          resumeSeconds={0}
          title="Test movie"
          onBack={noop}
          onPlay={noop}
          onPause={noop}
          onEnded={noop}
          onError={noop}
          onUnsupported={noop}
        />,
      );
    return { rerenderWith };
  }

  it('keeps the live stream when only the PlaySessionId changed', () => {
    const { rerenderWith } = renderWith(withSession('session-a'));
    expect(hlsInstances).toHaveLength(1);
    // Frames are coming out: this session is proven alive.
    fireEvent.playing(screen.getByTestId('pf-video'));

    rerenderWith(withSession('session-b'));

    expect(hlsInstances).toHaveLength(1);
    expect(hlsInstances[0].destroy).not.toHaveBeenCalled();
    expect(hlsInstances[0].loadSource).toHaveBeenCalledTimes(1);
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(withSession('session-a').hlsUrl);
  });

  // Re-entering an item with a warm React Query cache renders the previous
  // visit's URL first, and that transcode session is dead on the server. The
  // refetch behind it is the only thing that can rescue playback, so a source
  // that has never played a frame must still be replaceable.
  it('still adopts a new url when the current one never started playing', () => {
    const { rerenderWith } = renderWith(withSession('stale-session'));
    expect(hlsInstances).toHaveLength(1);

    rerenderWith(withSession('fresh-session'));

    expect(hlsInstances).toHaveLength(2);
    expect(hlsInstances[0].destroy).toHaveBeenCalled();
    expect(hlsInstances[1].loadSource).toHaveBeenCalledWith(withSession('fresh-session').hlsUrl);
  });

  it('reopens playback for a genuine audio-track change, even mid-playback', () => {
    const { rerenderWith } = renderWith(withSession('session-a', 1));
    fireEvent.playing(screen.getByTestId('pf-video'));

    rerenderWith(withSession('session-b', 2));

    expect(hlsInstances).toHaveLength(2);
    expect(hlsInstances[1].loadSource).toHaveBeenCalledWith(withSession('session-b', 2).hlsUrl);
  });

  it('treats each newly attached source as unproven again', () => {
    const { rerenderWith } = renderWith(withSession('session-a', 1));
    fireEvent.playing(screen.getByTestId('pf-video'));

    // A real audio change reopens playback...
    rerenderWith(withSession('session-b', 2));
    expect(hlsInstances).toHaveLength(2);
    // ...and the newly attached source has proven nothing yet, so a further
    // re-resolve of it is still allowed to replace the url.
    rerenderWith(withSession('session-c', 2));

    expect(hlsInstances).toHaveLength(3);
    expect(hlsInstances[2].loadSource).toHaveBeenCalledWith(withSession('session-c', 2).hlsUrl);
  });
});

describe('VideoSurface — identity guard on the paths that are not hls.js', () => {
  // DirectPlay urls never carried a PlaySessionId (`buildDirectPlayUrl` sets
  // only static/mediaSourceId/api_key), so the guard is a no-op here - but a
  // no-op that nothing demonstrated until now.
  it('reloads a DirectPlay source whenever its url changes, even mid-playback', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const props = {
      ...trackMenuDefaultProps,
      resumeSeconds: 0,
      title: 'Test movie',
      onBack: noop,
      onPlay: noop,
      onPause: noop,
      onEnded: noop,
      onError: noop,
      onUnsupported: noop,
    };
    const { rerender } = render(
      <VideoSurface videoRef={videoRef} {...props} source={{ kind: 'DirectPlay', url: '/a.mp4' }} />,
    );
    fireEvent.playing(screen.getByTestId('pf-video'));

    rerender(<VideoSurface videoRef={videoRef} {...props} source={{ kind: 'DirectPlay', url: '/b.mp4' }} />);

    expect(videoRef.current?.src).toContain('/b.mp4');
  });

  // Safari: no hls.js instance to inspect, so the veto is only observable on
  // the element's own `src`.
  it('keeps the attached url on native HLS when only the PlaySessionId changed', () => {
    hoisted.setSupported(false);
    const videoRef = createRef<HTMLVideoElement>();
    const props = {
      ...trackMenuDefaultProps,
      resumeSeconds: 0,
      title: 'Test movie',
      onBack: noop,
      onPlay: noop,
      onPause: noop,
      onEnded: noop,
      onError: noop,
      onUnsupported: noop,
    };
    const canPlayType = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockReturnValue('maybe');
    try {
      const { rerender } = render(
        <VideoSurface videoRef={videoRef} {...props} source={{ kind: 'Transcoded', hlsUrl: '/m.m3u8?PlaySessionId=a' }} />,
      );
      fireEvent.playing(screen.getByTestId('pf-video'));

      rerender(
        <VideoSurface videoRef={videoRef} {...props} source={{ kind: 'Transcoded', hlsUrl: '/m.m3u8?PlaySessionId=b' }} />,
      );

      expect(videoRef.current?.src).toContain('PlaySessionId=a');
    } finally {
      canPlayType.mockRestore();
    }
  });
});

describe('VideoSurface — picking the audio track that is already playing', () => {
  const audioTracks: MediaStreamTrack[] = [
    { index: 1, kind: 'Audio', language: 'spa', displayTitle: 'Espanol', isDefault: true, isForced: false },
    { index: 2, kind: 'Audio', language: 'eng', displayTitle: 'English', isDefault: false, isForced: false },
  ];

  // Without this guard the click re-resolved PlaybackInfo for the SAME index.
  // The reply differs only by PlaySessionId, so the element (correctly)
  // refuses to reload for it - leaving PlayerScreen's heartbeat and
  // subtitleDeliveryMethods describing a session that was never opened.
  it('does not ask the server to re-resolve the current track', () => {
    const onAudioSwitchUnavailable = vi.fn();
    const onAudioApplied = vi.fn();
    render(
      <VideoSurface
        videoRef={createRef<HTMLVideoElement>()}
        {...trackMenuDefaultProps}
        audioTracks={audioTracks}
        selectedAudioIndex={2}
        onAudioApplied={onAudioApplied}
        onAudioSwitchUnavailable={onAudioSwitchUnavailable}
        source={transcodedSource}
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
        onUnsupported={noop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    const dialog = screen.getByRole('dialog', { name: 'Audio' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Ingl|English/ }));

    expect(onAudioSwitchUnavailable).not.toHaveBeenCalled();
    expect(onAudioApplied).not.toHaveBeenCalled();
  });
});
