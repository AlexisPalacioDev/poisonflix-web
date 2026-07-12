import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoSurface } from './VideoSurface';

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
