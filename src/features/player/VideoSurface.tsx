import Hls from 'hls.js';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { PlaybackSource } from '../../lib/domain/streamResolver';
import { audioTracksOf, subtitleTracksOf, trackLabel, type MediaStreamTrack } from './mediaStreamTracks';
import { formatSeekStep, newSeekRun, nextSeekStep, RESET_AFTER_MS } from '../../lib/domain/seekAccelerator';
import { AudioTrackMenu, SubtitleTrackMenu } from './TrackMenu';
import './VideoSurface.css';

// `<video>` wrapper (design.md §10, ← `PlaybackController.kt`, tasks.md
// 7.2/7.3/7.6). Handles BOTH `PlaybackSource` variants:
// - `DirectPlay` -> `video.src` set directly (existing, live-validated path).
// - `Transcoded` (server-side HLS transcode) -> `hls.js` when
//   `Hls.isSupported()`, else native HLS (`video.canPlayType(...)`, i.e.
//   Safari) via `video.src`, else the genuinely-rare "not playable in this
//   browser" case surfaced via `onUnsupported`.
// Custom controls sit over the native `<video>` (play/pause, seek bar,
// volume/mute, back, fullscreen, audio/subtitle track menus), auto-hiding
// after inactivity and keyboard-operable (space/enter toggles play, arrow
// keys seek/adjust volume) so the same primitive can later opt into webOS
// spatial nav without restructuring (design.md §9).
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
//
// ## Audio/subtitle track switching (player spec §8, projector-feature-map.md
// §8, ← `TrackMenu.kt` + `PlayerViewModel.selectAudio`/`switchAudioUnderTranscode`
// + `PlaybackController.selectAudioTrack`/`selectSubtitleTrack`)
//
// Audio:
// - DirectPlay: the browser's `HTMLVideoElement.audioTracks` API (feature-
//   detected - it's a real but inconsistently-implemented W3C API; Chrome
//   ships it, Firefox/Safari support varies) - tracks are correlated to
//   Jellyfin's `MediaStream`s by ORDINAL position (Nth audio MediaStream <->
//   Nth `audioTracks` entry), same assumption (and same "not verified against
//   a real multi-audio-track file" caveat) as `PlaybackController.kt`'s
//   header.
// - Transcoded: `hls.audioTracks`/`hls.audioTrack`, same ordinal correlation,
//   ONLY attempted when hls.js actually offers more than one audio rendition
//   (`hls.audioTracks.length > 1`) - in practice a Jellyfin HLS transcode
//   almost always muxes exactly ONE server-picked audio stream, so this path
//   is rarely available; that's expected, not a bug.
// - Fallback (whenever neither of the above applies - most Transcoded
//   sessions, or a browser without `audioTracks`): `onAudioSwitchUnavailable`
//   signals the parent (`PlayerScreen`) to re-resolve `PlaybackInfo` with the
//   picked `AudioStreamIndex` and reopen at the saved position - the actual
//   primary path for transcode audio switching, ported as
//   `switchAudioUnderTranscode`.
//
// Subtitles:
// - DirectPlay: sideloaded `<track kind="subtitles">` elements (one per
//   subtitle MediaStream, `src` built by `buildSubtitleDeliveryUrl`),
//   toggled via each track's own `.track.mode` ('showing'/'disabled') -
//   matched by OUR OWN stable `track.index` key, so there's no id-prefix
//   ambiguity to guard against on this path (unlike the Kotlin reference's
//   Media3 `Format.id` matching).
// - Transcoded: `hls.subtitleTracks`/`hls.subtitleTrack` (`-1` disables),
//   ordinal-matched like audio. hls.js's own `MediaPlaylist.id` is a plain
//   ordinal number it hands out itself (not a prefixed string), so the
//   Kotlin reference's `":"`-prefix `Format.id` quirk (a Media3-specific
//   bug) has no direct equivalent here - documented rather than blindly
//   ported, since guarding against a bug that can't occur on this API would
//   just be dead code.
// - Native HLS (Safari, no hls.js instance): audio/subtitle switching is NOT
//   implemented - `hlsRef.current` is null on this path, so a selection just
//   falls through to `onAudioSwitchUnavailable`/is a no-op for subtitles.
//   Flagged here explicitly as the one genuinely-partial corner of this
//   feature.

const CONTROLS_HIDE_DELAY_MS = 3000;
const VOLUME_STEP = 0.1;

/** Minimal shape of the experimental `HTMLMediaElement.audioTracks` W3C API
 * - not in TS's `lib.dom.d.ts` (it's still non-standard/partially shipped),
 * so this is declared locally rather than widening a shared type. */
interface BrowserAudioTrack {
  enabled: boolean;
}
interface BrowserAudioTrackList {
  readonly length: number;
  [index: number]: BrowserAudioTrack;
}

function sourceKey(source: PlaybackSource): string {
  return source.kind === 'DirectPlay' ? `direct:${source.url}` : `hls:${source.hlsUrl}`;
}

type ActiveMenu = 'audio' | 'subtitle' | null;

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
  /** Audio/subtitle MediaStreams for this item, enumerated up-front (player spec §8). */
  audioTracks: MediaStreamTrack[];
  subtitleTracks: MediaStreamTrack[];
  /** `null` == no subtitle selected ("Ninguno"). */
  selectedAudioIndex: number | null;
  selectedSubtitleIndex: number | null;
  /** An in-band audio switch (browser `audioTracks` or hls.js) succeeded. */
  onAudioApplied: (track: MediaStreamTrack) => void;
  /** Neither switching path was available - the parent must re-resolve
   * `PlaybackInfo` with this track's index and reopen (see file header). */
  onAudioSwitchUnavailable: (track: MediaStreamTrack) => void;
  onSubtitleApplied: (track: MediaStreamTrack | null) => void;
  buildSubtitleUrl: (track: MediaStreamTrack) => string;
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

/* Inline SVG control icons (Lucide-style 24px stroke geometry) - replace the
   old emoji glyphs so the chrome reads as a real player, renders identically
   across platforms, and inherits button color via `currentColor`. All are
   decorative (`aria-hidden`); the accessible name lives on the parent button. */
type IconProps = { className?: string };

function Svg({ children, filled = false }: { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      className="pf-icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const IconBack = () => (
  <Svg>
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </Svg>
);
const IconPlay = () => (
  <Svg filled>
    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
  </Svg>
);
const IconPause = () => (
  <Svg filled>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </Svg>
);
const IconVolumeHigh = () => (
  <Svg>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 5a9 9 0 0 1 0 14" />
  </Svg>
);
const IconVolumeMuted = () => (
  <Svg>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="m23 9-6 6" />
    <path d="m17 9 6 6" />
  </Svg>
);
const IconSubtitles = ({ className }: IconProps) => (
  <svg
    className={`pf-icon${className ? ` ${className}` : ''}`}
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 12h4" />
    <path d="M14 12h4" />
    <path d="M6 15.5h2" />
    <path d="M12 15.5h6" />
  </svg>
);
const IconAudio = () => (
  <Svg>
    <path d="M3 16v-4a9 9 0 0 1 18 0v4" />
    <path d="M21 17a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z" />
    <path d="M3 17a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z" />
  </Svg>
);
const IconFullscreen = () => (
  <Svg>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
  </Svg>
);
const IconFullscreenExit = () => (
  <Svg>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
  </Svg>
);

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
  audioTracks,
  subtitleTracks,
  selectedAudioIndex,
  selectedSubtitleIndex,
  onAudioApplied,
  onAudioSwitchUnavailable,
  onSubtitleApplied,
  buildSubtitleUrl,
}: VideoSurfaceProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Only ever true on browsers without element-level Fullscreen API (iOS).
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);

  // Resume-seek-once guard (player spec: "only when position > 0"; carried
  // forward gotcha: never seek before metadata is actually ready, and never
  // re-seek a second time once the guard has fired for DirectPlay).
  const hasSeekedResumeRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Initial-subtitle-apply-once guard + latest-value refs so the source-setup
  // effect (keyed only on `key`, see below) can read the CURRENT selection
  // without re-running every time the parent updates it (e.g. after the user
  // picks a track, which is applied directly by the select handlers instead).
  const initialSubtitleAppliedRef = useRef(false);
  // Accelerating seek: holding an arrow climbs 5s -> 10s -> 30s -> 1min ...
  // and snaps back once released. Held in a ref rather than state because it
  // changes on every keypress and nothing renders from it directly.
  const seekRunRef = useRef(newSeekRun());
  const takeSeekStep = (): number => {
    const { seconds, run } = nextSeekStep(seekRunRef.current, Date.now());
    seekRunRef.current = run;
    setSeekStepHint(seconds);
    return seconds;
  };
  const [seekStepHint, setSeekStepHint] = useState<number | null>(null);
  // Clears itself once seeking stops, so the hint reflects a run in progress
  // rather than lingering as a stale number over a paused film.
  useEffect(() => {
    if (seekStepHint === null) return;
    const timer = window.setTimeout(() => setSeekStepHint(null), RESET_AFTER_MS + 400);
    return () => window.clearTimeout(timer);
  }, [seekStepHint]);

  const subtitleTracksRef = useRef(subtitleTracks);
  subtitleTracksRef.current = subtitleTracks;
  const selectedSubtitleIndexRef = useRef(selectedSubtitleIndex);
  selectedSubtitleIndexRef.current = selectedSubtitleIndex;
  const audioTracksRef = useRef(audioTracks);
  audioTracksRef.current = audioTracks;
  const trackElsRef = useRef<Map<number, HTMLTrackElement>>(new Map());

  const key = sourceKey(source);

  // A new source (different item, or DirectPlay<->Transcoded switch) must
  // reset every per-playback guard/state, or resume-seek and the displayed
  // clock would silently carry over from whatever was playing before.
  useEffect(() => {
    hasSeekedResumeRef.current = false;
    initialSubtitleAppliedRef.current = false;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setActiveMenu(null);
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

  /** Applies `track` (or clears, for `null` == "Ninguno") on the CURRENT
   * source - DirectPlay's sideloaded `<track>` elements, or hls.js's
   * `subtitleTrack` under transcode. No-ops (documented limitation) under
   * native Safari HLS, which has no hls.js instance to act on. */
  const applySubtitle = (track: MediaStreamTrack | null) => {
    if (source.kind === 'DirectPlay') {
      for (const [idx, el] of trackElsRef.current) {
        if (el.track) el.track.mode = track && idx === track.index ? 'showing' : 'disabled';
      }
    } else if (hlsRef.current) {
      const hls = hlsRef.current;
      if (!track) {
        hls.subtitleTrack = -1;
      } else {
        const ordinal = subtitleTracksRef.current.findIndex((t) => t.index === track.index);
        const hlsTrack = ordinal >= 0 ? hls.subtitleTracks[ordinal] : undefined;
        if (hlsTrack) hls.subtitleTrack = hlsTrack.id;
      }
    }
  };

  const applyInitialSubtitleOnce = () => {
    if (initialSubtitleAppliedRef.current) return;
    initialSubtitleAppliedRef.current = true;
    const idx = selectedSubtitleIndexRef.current;
    const track = idx == null ? null : (subtitleTracksRef.current.find((t) => t.index === idx) ?? null);
    applySubtitle(track);
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
      applyInitialSubtitleOnce();
      return undefined;
    }

    // Transcoded: server-side HLS.
    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyResumeSeekOnce();
        applyInitialSubtitleOnce();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onError();
      });
      hls.loadSource(source.hlsUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari) - no hls.js instance to manage; audio/subtitle
      // switching is unavailable on this path (see file header).
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
      if (videoRef.current && !videoRef.current.paused && activeMenu == null) setControlsVisible(false);
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

  // Keep the fullscreen icon in sync with the actual state - the user can
  // leave fullscreen via Esc/OS chrome, not just our own button.
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
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
    } else if (pseudoFullscreen) {
      setPseudoFullscreen(false);
    } else if (el.requestFullscreen) {
      void el.requestFullscreen();
    } else {
      // iOS Safari exposes the Fullscreen API on <video> ONLY, never on a
      // container div - so `el.requestFullscreen` is undefined here and the
      // button used to do nothing at all. The <video> route does exist
      // (webkitEnterFullscreen) but it hands playback to the OS player, which
      // is precisely the chrome-stealing bug `playsInline` above fixes. A CSS
      // overlay is the only fullscreen that keeps our own controls reachable.
      setPseudoFullscreen(true);
    }
  };

  const handleSelectAudio = (track: MediaStreamTrack) => {
    let applied = false;
    if (source.kind === 'DirectPlay') {
      const webVideo = videoRef.current as unknown as { audioTracks?: BrowserAudioTrackList } | null;
      const list = webVideo?.audioTracks;
      if (list && list.length > 0) {
        const ordinal = audioTracksRef.current.findIndex((t) => t.index === track.index);
        for (let i = 0; i < list.length; i += 1) list[i].enabled = i === ordinal;
        applied = true;
      }
    } else if (hlsRef.current && hlsRef.current.audioTracks.length > 1) {
      const ordinal = audioTracksRef.current.findIndex((t) => t.index === track.index);
      const hlsTrack = ordinal >= 0 ? hlsRef.current.audioTracks[ordinal] : undefined;
      if (hlsTrack) {
        hlsRef.current.audioTrack = hlsTrack.id;
        applied = true;
      }
    }
    setActiveMenu(null);
    if (applied) onAudioApplied(track);
    else onAudioSwitchUnavailable(track);
  };

  const handleSelectSubtitle = (track: MediaStreamTrack | null) => {
    applySubtitle(track);
    setActiveMenu(null);
    onSubtitleApplied(track);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (activeMenu != null) return; // menu owns keyboard input while open
    revealControls();
    switch (event.key) {
      case ' ':
      case 'Enter':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        seekBy(takeSeekStep());
        break;
      case 'ArrowLeft':
        seekBy(-takeSeekStep());
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

  const subtitles = subtitleTracksOf(subtitleTracks);
  const audios = audioTracksOf(audioTracks);

  // Percentages drive the gold "played"/"level" fill of the custom-styled
  // range inputs (a CSS gradient keyed on these vars), so the seek and volume
  // bars read like a real player instead of a bare native slider.
  const seekMax = duration || 0;
  const seekFillPct = seekMax > 0 ? (currentTime / seekMax) * 100 : 0;
  const volumeValue = isMuted ? 0 : volume;
  const seekStyle = { '--pf-range-fill': `${seekFillPct}%` } as React.CSSProperties;
  const volumeStyle = { '--pf-range-fill': `${volumeValue * 100}%` } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className={`pf-player-surface${pseudoFullscreen ? ' pf-player-surface--pseudo-fullscreen' : ''}`}
      onMouseMove={revealControls}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <video
        ref={videoRef}
        className="pf-player-surface__video"
        data-testid="pf-video"
        // `src` is set imperatively (DirectPlay direct assignment, or hls.js
        // attachMedia/native-HLS assignment) in the effect above - never via
        // this JSX attribute, so React never fights hls.js for control of it.
        autoPlay
        // Without this, iOS Safari refuses to play a <video> inline and hands
        // it to the OS fullscreen player instead - which paints its own chrome
        // over ours, so every custom control (subtitle picker, audio track,
        // back button) becomes unreachable mid-playback. The custom controls
        // below are only ever visible because playback stays in our element.
        playsInline
        onLoadedMetadata={() => {
          setDuration(videoRef.current?.duration ?? 0);
          // Gotcha (file header, point 1): only DirectPlay's resume seek is
          // safe on `loadedmetadata` - HLS (hls.js or native) seeks on
          // MANIFEST_PARSED/`canplay` instead.
          if (source.kind === 'DirectPlay') applyResumeSeekOnce();
        }}
        onCanPlay={() => {
          applyResumeSeekOnce();
          applyInitialSubtitleOnce();
        }}
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
      >
        {source.kind === 'DirectPlay'
          ? subtitles.map((track) => (
              <track
                key={track.index}
                ref={(el) => {
                  if (el) trackElsRef.current.set(track.index, el);
                  else trackElsRef.current.delete(track.index);
                }}
                kind="subtitles"
                src={buildSubtitleUrl(track)}
                srcLang={track.language ?? undefined}
                label={trackLabel(track)}
              />
            ))
          : null}
      </video>

      <div
        className={`pf-player-surface__controls${controlsVisible ? '' : ' pf-player-surface__controls--hidden'}`}
        // Clicking the empty video area (never a button/slider) toggles
        // play/pause, the way every mainstream player behaves.
        onClick={(event) => {
          if (event.target === event.currentTarget) togglePlay();
        }}
      >
        <div className="pf-player-surface__top">
          <button type="button" className="pf-player-surface__icon-btn pf-player-surface__back" onClick={onBack} aria-label="Volver">
            <IconBack />
          </button>
          <span className="pf-player-surface__title">{title}</span>
        </div>

        <button
          type="button"
          className="pf-player-surface__center"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          tabIndex={-1}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>

        <div className="pf-player-surface__bottom">
          <div className="pf-player-surface__scrubber">
            <input
              type="range"
              className="pf-player-surface__seek"
              min={0}
              max={seekMax}
              step={0.1}
              value={currentTime}
              style={seekStyle}
              onChange={(event) => handleSeekInput(Number(event.target.value))}
              aria-label="Progreso de la reproducción"
            />
          </div>

          <div className="pf-player-surface__bar">
            <button
              type="button"
              className="pf-player-surface__icon-btn"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            >
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>

            <div className="pf-player-surface__volume-group">
              <button
                type="button"
                className="pf-player-surface__icon-btn"
                onClick={toggleMute}
                aria-label={isMuted || volume === 0 ? 'Activar sonido' : 'Silenciar'}
              >
                {isMuted || volume === 0 ? <IconVolumeMuted /> : <IconVolumeHigh />}
              </button>
              <input
                type="range"
                className="pf-player-surface__volume"
                min={0}
                max={1}
                step={0.05}
                value={volumeValue}
                style={volumeStyle}
                onChange={(event) => handleVolumeChange(Number(event.target.value))}
                aria-label="Volumen"
              />
            </div>

            <span className="pf-player-surface__time">
              {formatTime(currentTime)}
              <span className="pf-player-surface__time-sep"> / </span>
              {formatTime(duration)}
              {/* The live jump size while seeking. Without it the acceleration
                  is something you infer from how far the bar moved. */}
              {seekStepHint !== null && (
                <span className="pf-player-surface__seek-step">
                  {` ± ${formatSeekStep(seekStepHint)}`}
                </span>
              )}
            </span>

            <div className="pf-player-surface__spacer" />

            <button
              type="button"
              className="pf-player-surface__icon-btn"
              onClick={() => setActiveMenu('subtitle')}
              aria-label="Subtítulos"
              aria-haspopup="dialog"
            >
              <IconSubtitles />
            </button>

            {audios.length > 0 ? (
              <button
                type="button"
                className="pf-player-surface__icon-btn"
                onClick={() => setActiveMenu('audio')}
                aria-label="Audio"
                aria-haspopup="dialog"
              >
                <IconAudio />
              </button>
            ) : null}

            <button
              type="button"
              className="pf-player-surface__icon-btn"
              onClick={toggleFullscreen}
              aria-label={
                isFullscreen || pseudoFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'
              }
            >
              {isFullscreen || pseudoFullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
            </button>
          </div>
        </div>
      </div>

      {activeMenu === 'audio' ? (
        <AudioTrackMenu
          tracks={audioTracks}
          selectedIndex={selectedAudioIndex}
          onSelect={handleSelectAudio}
          onDismiss={() => setActiveMenu(null)}
        />
      ) : null}
      {activeMenu === 'subtitle' ? (
        <SubtitleTrackMenu
          tracks={subtitleTracks}
          selectedIndex={selectedSubtitleIndex}
          onSelect={handleSelectSubtitle}
          onDismiss={() => setActiveMenu(null)}
        />
      ) : null}
    </div>
  );
}
