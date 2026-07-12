import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import './VideoSurface.css';

// `<video>` wrapper (design.md §10, ← `PlaybackController.kt`, tasks.md
// 7.2/7.3/7.6). DirectPlay only for the MVP - `PlayerScreen` never mounts
// this component for a `Transcoded` source; it renders the explicit
// not-supported state itself instead (player spec: no silent playback
// attempt). Custom controls sit over the native `<video>` (play/pause, seek
// bar, volume/mute, back, fullscreen), auto-hiding after inactivity and
// keyboard-operable (space/enter toggles play, arrow keys seek/adjust
// volume) so the same primitive can later opt into webOS spatial nav
// without restructuring (design.md §9).
//
// Carried-forward hls.js design notes (NOT implemented here - deferred per
// the player spec's Deferred section):
// 1. Resume-seek-after-ready: under hls.js the seek must be REAPPLIED after
//    a *second* ready event fires (`PlaybackController.kt` L96-104,
//    L199-205) - DirectPlay only needs the single seek-once-on-metadata
//    guard below because the whole file is byte-addressable from the start
//    (Slice 2's SPIKE VERDICT: GO). Re-verify this guard once transcode
//    lands.
// 2. Subtitle id-prefix bug (`PlaybackController.kt` L265-275): hls.js's
//    text-track ids need prefix/suffix matching, never exact `==`, once
//    transcode+subtitle track switching lands. N/A for DirectPlay - no
//    subtitle track switching in this slice.

const CONTROLS_HIDE_DELAY_MS = 3000;
const SEEK_STEP_SECONDS = 10;
const VOLUME_STEP = 0.1;

export interface VideoSurfaceProps {
  videoRef: RefObject<HTMLVideoElement>;
  src: string;
  /** Resume position in seconds; `0` means "no seek" (player spec). */
  resumeSeconds: number;
  title: string;
  onBack: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onError: () => void;
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
  src,
  resumeSeconds,
  title,
  onBack,
  onPlay,
  onPause,
  onEnded,
  onError,
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

  // A new `src` (different item) must reset every per-playback guard/state,
  // or resume-seek and the displayed clock would silently carry over from
  // whatever was playing before.
  useEffect(() => {
    hasSeekedResumeRef.current = false;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [src]);

  const applyResumeSeekOnce = () => {
    const video = videoRef.current;
    if (!video || hasSeekedResumeRef.current) return;
    hasSeekedResumeRef.current = true;
    if (resumeSeconds > 0) {
      video.currentTime = resumeSeconds;
      setCurrentTime(resumeSeconds);
    }
  };

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
        src={src}
        autoPlay
        onLoadedMetadata={() => {
          setDuration(videoRef.current?.duration ?? 0);
          applyResumeSeekOnce();
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
