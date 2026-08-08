import { createRef } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoSurface } from './VideoSurface';
import type { MediaStreamTrack } from './mediaStreamTracks';

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
// elements). Word-by-word highlighting is explicitly OUT OF SCOPE and not
// implemented.
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(englishTrackEl.track?.mode).toBe('disabled');

    // Land the video's clock inside both cues' [1s, 3s) window and let the
    // overlay pick up the active line - the SAME `currentTime` state this
    // file already updates on every `timeupdate`, no extra listener.
    Object.defineProperty(video, 'currentTime', { value: 1.5, configurable: true });
    fireEvent.timeUpdate(video);

    expect(await screen.findByText('Hello there.')).toBeInTheDocument();
    expect(screen.getByText('Hola.')).toBeInTheDocument();
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
    // No dual overlay, and the VTT-fetch effect never runs - the second slot
    // being `null` is a structural no-op, not merely an empty render.
    expect(document.querySelector('.pf-player-surface__dual-subtitles')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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

    // No crash, no overlay, no wasted fetch - and the PRIMARY (non-burned)
    // subtitle keeps rendering exactly like single-subtitle mode always did.
    expect(document.querySelector('.pf-player-surface__dual-subtitles')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The overlay container still mounts (dual mode IS selected/valid), it
    // just has no active line to show - never a thrown error or a blank
    // white-screen.
    const overlay = document.querySelector('.pf-player-surface__dual-subtitles');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('p')).toHaveLength(0);
  });
});
