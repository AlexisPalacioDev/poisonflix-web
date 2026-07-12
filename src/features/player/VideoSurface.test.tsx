import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoSurface } from './VideoSurface';

function noop() {
  /* test double */
}

describe('VideoSurface (player spec: "Resume seek on ready")', () => {
  it('seeks to the resume position exactly once, after loadedmetadata fires', () => {
    const videoRef = createRef<HTMLVideoElement>();
    render(
      <VideoSurface
        videoRef={videoRef}
        src="/jellyfin/Videos/item-1/stream.mp4"
        resumeSeconds={42}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
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
        src="/jellyfin/Videos/item-2/stream.mp4"
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(0);
  });

  it('resets the resume-seek guard when src changes (a second, different video)', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const { rerender } = render(
      <VideoSurface
        videoRef={videoRef}
        src="/jellyfin/Videos/item-1/stream.mp4"
        resumeSeconds={10}
        title="First movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
      />,
    );

    const video = screen.getByTestId('pf-video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(10);

    rerender(
      <VideoSurface
        videoRef={videoRef}
        src="/jellyfin/Videos/item-2/stream.mp4"
        resumeSeconds={77}
        title="Second movie"
        onBack={noop}
        onPlay={noop}
        onPause={noop}
        onEnded={noop}
        onError={noop}
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
        src="/jellyfin/Videos/item-1/stream.mp4"
        resumeSeconds={0}
        title="Test movie"
        onBack={noop}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onError={noop}
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
});
