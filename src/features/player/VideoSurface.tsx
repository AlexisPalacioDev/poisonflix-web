import Hls from 'hls.js';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { PlaybackSource } from '../../lib/domain/streamResolver';
import './VideoSurface.css';

// `<video>` wrapper (design.md §10, ← `PlaybackController.kt`, tasks.md
// 7.2/7.3/7.6). Handles BOTH `PlaybackSource` variants:
// - `DirectPlay` -> `video.src` set directly (existing, live-validated path).
// - `Transcoded` (server-side HLS transcode) -> `hls.js` when
//   `Hls.isSupported()`, else native HLS (`video.canPlayType(...)`, i.e.
//   Safari) via `video.src`, else the genuinely-rare "not playable in this
//   browser" case surfaced via `onUnsupported`.
// Custom controls sit over the native `<video>` (play/pause, seek bar,
// volume/mute, back, fullscreen), auto-hiding after inactivity and
// keyboard-operable (space/enter toggles play, arrow keys seek/adjust
// volume) so the same primitive can later opt into webOS spatial nav
// without restructuring (design.md §9).
//
// Carried-forward hls.js gotchas (design.md §10, `PlaybackController.kt`):
// 1. Resume-seek-after-ready: under HLS (hls.js OR native), the resume seek
//    must be applied only after the manifest/source is genuinely ready
//    (hls.js's `MANIFEST_PARSED` event, or the video's `canplay` event for
//    native HLS) - NOT on `loadedmetadata`, which DirectPlay honors but HLS
//    does not reliably (`PlaybackController.kt` L96-104, L199-205). The
//    `loadedmetadata` handler below only fires the seek for `DirectPlay`;
//    `canplay` remains the catch-all for every mode (idempotent via the
//    seek-once guard).
// 2. Subtitle id-prefix bug (`PlaybackController.kt` L265-275): hls.js's
//    text-track ids need prefix/suffix matching, never exact `==`, once
//    transcode+subtitle track switching lands (still deferred - this file
//    only plays video/audio, no subtitle tracks yet).

const CONTROLS_HIDE_DELAY_MS = 3000;
const SEEK_STEP_SECONDS = 10;
const VOLUME_STEP = 0.1;

function sourceKey(source: PlaybackSource): string {
  return source.kind === 'DirectPlay' ? `direct:${source.url}` : `hls:${source.hlsUrl}`;
}

export interface VideoSurfaceProps {
  videoRef: RefObject<HTMLVideoElement>;
  source: PlaybackSource;
  /** Resume position in seconds; `0` means "no seek" (player spec). */
  resumeSeconds: number;
  title: string;
  onBack: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onError: () => void;
  /** Fired when neither hls.js nor native HLS is available for a `Transcoded` source - a genuinely rare "this browser can't play this" case. */
  onUnsupported: () => void;
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

export function VideoSurface({
  videoRef,
  source,
  resumeSeconds,
  title,
  onBack,
  onPlay,
  onPause,
  onEnded,
  onError,
  onUnsupported,
}: VideoSurfaceProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  // Resume-seek-once guard (player spec: "only when position > 0"; carried
  // forward gotcha: never seek before metadata is actually ready, and never
  // re-seek a second time once the guard has fired for DirectPlay).
  const hasSeekedResumeRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const key = sourceKey(source);

  // A new source (different item, or DirectPlay<->Transcoded switch) must
  // reset every per-playback guard/state, or resume-seek and the displayed
  // clock would silently carry over from whatever was playing before.
  useEffect(() => {
    hasSeekedResumeRef.current = false;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [key]);

  const applyResumeSeekOnce = () => {
    const video = videoRef.current;
    if (!video || hasSeekedResumeRef.current) return;
    hasSeekedResumeRef.current = true;
    if (resumeSeconds > 0) {
      video.currentTime = resumeSeconds;
      setCurrentTime(resumeSeconds);
    }
  };

  // Attaches the resolved source to the <video> element: DirectPlay sets
  // `src` directly; Transcoded (HLS) prefers hls.js (works in every
  // evergreen browser lacking native HLS - Chrome, Firefox, Edge), falls
  // back to native HLS (`video.src`) for Safari, and surfaces the rare
  // "can't play this" case via `onUnsupported` otherwise.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (source.kind === 'DirectPlay') {
      video.src = source.url;
      return undefined;
    }

    // Transcoded: server-side HLS.
    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, applyResumeSeekOnce);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onError();
      });
      hls.loadSource(source.hlsUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari) - no hls.js instance to manage.
      video.src = source.hlsUrl;
    } else {
      onUnsupported();
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const scheduleHideControls = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  };

  const revealControls = () => {
    setControlsVisible(true);
    scheduleHideControls();
  };

  useEffect(() => {
    scheduleHideControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const seekBy = (deltaSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const max = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(video.currentTime + deltaSeconds, 0), max);
    setCurrentTime(video.currentTime);
  };

  const handleSeekInput = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const handleVolumeChange = (value: number) => {
    const video = videoRef.current;
    const clamped = Math.min(1, Math.max(0, value));
    setVolume(clamped);
    if (!video) return;
    video.volume = clamped;
    const shouldMute = clamped === 0;
    video.muted = shouldMute;
    setIsMuted(shouldMute);
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (el.requestFullscreen) {
      void el.requestFullscreen();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    revealControls();
    switch (event.key) {
      case ' ':
      case 'Enter':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        seekBy(SEEK_STEP_SECONDS);
        break;
      case 'ArrowLeft':
        seekBy(-SEEK_STEP_SECONDS);
        break;
      case 'ArrowUp':
        event.preventDefault();
        handleVolumeChange(volume + VOLUME_STEP);
        break;
      case 'ArrowDown':
        event.preventDefault();
        handleVolumeChange(volume - VOLUME_STEP);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className="pf-player-surface"
      onMouseMove={revealControls}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- subtitle tracks are deferred (hls.js seam, see file header) */}
      <video
        ref={videoRef}
        className="pf-player-surface__video"
        data-testid="pf-video"
        // `src` is set imperatively (DirectPlay direct assignment, or hls.js
        // attachMedia/native-HLS assignment) in the effect above - never via
        // this JSX attribute, so React never fights hls.js for control of it.
        autoPlay
        onLoadedMetadata={() => {
          setDuration(videoRef.current?.duration ?? 0);
          // Gotcha (file header, point 1): only DirectPlay's resume seek is
          // safe on `loadedmetadata` - HLS (hls.js or native) seeks on
          // MANIFEST_PARSED/`canplay` instead.
          if (source.kind === 'DirectPlay') applyResumeSeekOnce();
        }}
        onCanPlay={applyResumeSeekOnce}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onPlay={() => {
          setIsPlaying(true);
          onPlay();
        }}
        onPause={() => {
          setIsPlaying(false);
          onPause();
        }}
        onEnded={() => {
          setIsPlaying(false);
          onEnded();
        }}
        onError={onError}
      />

      <div className={`pf-player-surface__controls${controlsVisible ? '' : ' pf-player-surface__controls--hidden'}`}>
        <button type="button" className="pf-player-surface__back" onClick={onBack} aria-label="Volver">
          ←
        </button>

        <span className="pf-player-surface__title">{title}</span>

        <div className="pf-player-surface__bar">
          <button
            type="button"
            className="pf-player-surface__play"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          >
            {isPlaying ? '❚❚' : '►'}
          </button>

          <span className="pf-player-surface__time">{formatTime(currentTime)}</span>

          <input
            type="range"
            className="pf-player-surface__seek"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={(event) => handleSeekInput(Number(event.target.value))}
            aria-label="Progreso de la reproducción"
          />

          <span className="pf-player-surface__time">{formatTime(duration)}</span>

          <button
            type="button"
            className="pf-player-surface__mute"
            onClick={toggleMute}
            aria-label={isMuted || volume === 0 ? 'Activar sonido' : 'Silenciar'}
          >
            {isMuted || volume === 0 ? '🔇' : '🔊'}
          </button>

          <input
            type="range"
            className="pf-player-surface__volume"
            min={0}
            max={1}
            step={0.05}
            value={isMuted ? 0 : volume}
            onChange={(event) => handleVolumeChange(Number(event.target.value))}
            aria-label="Volumen"
          />

          <button
            type="button"
            className="pf-player-surface__fullscreen"
            onClick={toggleFullscreen}
            aria-label="Pantalla completa"
          >
            ⛶
          </button>
        </div>
      </div>
    </div>
  );
}
