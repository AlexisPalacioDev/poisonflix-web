import Hls from 'hls.js';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { SubtitleDeliveryMethod } from '../../api/schemas/jellyfin';
import type { PlaybackSource } from '../../lib/domain/streamResolver';
import { audioTracksOf, isBurnedInSubtitle, subtitleTracksOf, trackLabel, type MediaStreamTrack } from './mediaStreamTracks';
import { formatSeekStep, newSeekRun, nextSeekStep, RESET_AFTER_MS } from '../../lib/domain/seekAccelerator';
import { AudioTrackMenu, SubtitleTrackMenu } from './TrackMenu';
import { EpisodeMenu } from './EpisodeMenu';
import { nextEpisode, previousEpisode, type EpisodeNavItem } from './episodeNavigation';
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
// - DirectPlay: attempts the browser's `HTMLVideoElement.audioTracks` API
//   (feature-detected, `attemptInBandAudioSwitch` below) - tracks are
//   correlated to Jellyfin's `MediaStream`s by ORDINAL position (Nth audio
//   MediaStream <-> Nth `audioTracks` entry). CORRECTION: an earlier version
//   of this comment claimed "Chrome ships it" - that is FALSE, verified
//   against a real Chromium build (`'audioTracks' in
//   document.createElement('video')` is `false`; `window.AudioTrackList` is
//   `undefined`). Safari has partial support, Firefox behind a pref. This
//   branch is therefore currently dead code on Chromium, which makes it dead
//   for the large majority of this app's real users - flagged here so the
//   next person doesn't spend an evening debugging "why doesn't switching
//   work" assuming the API is there. It is intentionally still IN the code
//   (feature-detected, cheap, harmless where it doesn't apply) so it starts
//   working the moment either fact changes, and so both the manual pick
//   (`handleSelectAudio`) and the initial-restore path
//   (`applyCurrentAudioSelection`) try it consistently rather than one of
//   them skipping it.
// - Transcoded: `hls.audioTracks`/`hls.audioTrack`, same ordinal correlation,
//   ONLY attempted when hls.js actually offers more than one audio rendition
//   (`hls.audioTracks.length > 1`) - in practice a Jellyfin HLS transcode
//   almost always muxes exactly ONE server-picked audio stream, so this path
//   is rarely available; that's expected, not a bug.
// - Fallback (whenever neither of the above applies - most Transcoded
//   sessions, DirectPlay in Chrome, or a DirectPlay source where the pick
//   isn't the file's own default): `onAudioSwitchUnavailable` signals the
//   parent (`PlayerScreen`) to re-resolve `PlaybackInfo` with the picked
//   `AudioStreamIndex` and reopen at the saved position, ported as
//   `switchAudioUnderTranscode`. For a source that STAYS DirectPlay this
//   would be a structural no-op: `buildDirectPlayUrl` (streamResolver.ts)
//   always requests Jellyfin's `static=true` stream, which the server serves
//   byte-for-byte unprocessed and never reads `audioStreamIndex` from
//   (confirmed against Jellyfin server source, `VideosController`'s
//   static/progressive branches). That's exactly why `createBrowserDeviceProfile`
//   (deviceProfile.ts) declares `IsSecondaryAudio` unsupported for DirectPlay:
//   it makes Jellyfin's own `StreamBuilder` refuse DirectPlay for such a
//   track and hand back a real `TranscodingUrl` instead (video still
//   stream-copied, only audio re-encoded - see that file's header for the
//   verified mechanism, including the separate `MediaSourceId` requirement
//   `getPlaybackInfo`'s caller must also send for this to take effect at
//   all), so THIS fallback re-resolves into a `Transcoded` source it can
//   actually act on, rather than looping back to the same unusable static
//   URL. On Chromium (no `HTMLMediaElement.audioTracks`), this fallback is
//   therefore no longer a DirectPlay dead end - it works the same way the
//   already-shipped Transcoded case does.
//
// Subtitles:
// - Burned-in dedup bug fix (player spec, live evidence: Solo Leveling
//   S02E02): a subtitle whose `subtitleDeliveryMethods[index] === 'Encode'`
//   is ALREADY in the transcoded video's pixels
//   (`Jellyfin.Api.Helpers.MediaInfoHelper.SetDeviceSpecificSubtitleInfo`,
//   verified against jellyfin/jellyfin v10.11.11 - browsers can't render
//   ASS/SSA/PGS, so the server rasterizes it into the image instead of
//   delivering it as text). `subtitles` (the render list, below) filters
//   those OUT entirely - no `<track>` element is ever mounted for them - and
//   `applySubtitle` returns early for a target track flagged this way,
//   before touching either the sideload loop or the hls.js fallback (an
//   Encode-delivered subtitle has no HLS text rendition in the manifest
//   either, so blindly falling through would pick the WRONG ordinal hls
//   track). The menu still shows it as SELECTED
//   (`selectedSubtitleIndex`-driven, untouched by any of this) - the user
//   really is watching it, it's just server-rendered, not ours to render
//   again. See `isBurnedInSubtitle` (mediaStreamTracks.ts) for the predicate
//   and `subtitleDeliveryMethodsOf` (streamResolver.ts) for where the map
//   comes from.
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

// ## Episode navigation (owner request: prev/next/jump between a series'
// chapters, from the player). Only rendered when `isEpisode` is true (a
// movie has no siblings to navigate to). `previousEpisode`/`nextEpisode`
// are pure lookups over the already-sorted `episodes` list PlayerScreen
// passes down - VideoSurface owns rendering/interaction only, same split as
// the audio/subtitle menus, but unlike those there is no "apply in place"
// step: selecting an episode always means navigating to a different
// `/player/:id`, which is PlayerScreen's job (`onSelectEpisode`).

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

type ActiveMenu = 'audio' | 'subtitle' | 'episodes' | null;

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
  /** Subtitle stream index -> `DeliveryMethod`, for the CURRENT resolved
   * source (subtitle dedup bug fix - see this file's header). Empty for a
   * DirectPlay/no-transcode session. */
  subtitleDeliveryMethods: Record<number, SubtitleDeliveryMethod>;
  /** Fired instead of a purely client-side toggle when the CURRENT source
   * has anything burned in (`subtitleDeliveryMethods` contains an `Encode`
   * entry): switching away (to a different track, OR to "Ninguno") can't be
   * done by hiding a `<track>` - the burned-in pixels are already part of
   * the playing video, so the parent must re-resolve `PlaybackInfo` with the
   * new `SubtitleStreamIndex` (or `-1` for none) and reopen at the saved
   * position, mirroring `onAudioSwitchUnavailable`. */
  onSubtitleSwitchUnavailable: (track: MediaStreamTrack | null) => void;
  buildSubtitleUrl: (track: MediaStreamTrack) => string;
  /** True only for `Episode` items - gates the prev/next/jump episode
   * controls entirely (player spec: never shown for a movie). */
  isEpisode: boolean;
  /** The playing item's series, sorted (season, episode) ascending - empty
   * while `useSeriesEpisodeList` is still loading, or for non-episodes. */
  episodes: EpisodeNavItem[];
  currentEpisodeId: string;
  /** Navigates the player to a different episode - PlayerScreen's job
   * (`navigate('/player/:id')`), not VideoSurface's. */
  onSelectEpisode: (episodeId: string) => void;
  /** Only used to authenticate episode thumbnails in the jump menu, which an
   * `<img>` can carry as `api_key` but not as a header. Optional so the
   * surface still renders (text-only rows) wherever a session isn't handy. */
  jellyfinToken?: string | null;
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
const IconSkipPrevious = () => (
  <Svg>
    <polygon points="19 20 9 12 19 4 19 20" />
    <line x1="5" y1="19" x2="5" y2="5" />
  </Svg>
);
const IconSkipNext = () => (
  <Svg>
    <polygon points="5 4 15 12 5 20 5 4" />
    <line x1="19" y1="5" x2="19" y2="19" />
  </Svg>
);
const IconEpisodes = () => (
  <Svg>
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
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
  subtitleDeliveryMethods,
  onSubtitleSwitchUnavailable,
  buildSubtitleUrl,
  isEpisode,
  episodes,
  currentEpisodeId,
  onSelectEpisode,
  jellyfinToken,
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

  // Tracks which subtitle/audio index has ALREADY been applied to the
  // CURRENT source, so the retry-effects below (keyed on the resolved
  // selection, see `applyCurrentSubtitleSelection`/the initial-audio-apply
  // effect) are idempotent instead of re-doing work on every unrelated
  // parent re-render. `undefined` = "nothing applied yet for this source" -
  // distinct from `null`, which IS a valid applied subtitle value ("no
  // subtitle"/"Ninguno").
  //
  // These REPLACE a previous "apply exactly once" boolean guard that fired
  // inside the same effect that attaches `source` to the <video> (keyed only
  // on `key`, ready as soon as `usePlaybackInfo` resolves) - but
  // `selectedSubtitleIndex`/`selectedAudioIndex` come from PlayerScreen's
  // SEPARATE `useItemMediaStreams` query and its own `useEffect`, which is
  // not guaranteed to run before this component's child effects do (React
  // runs child effects before parent effects within the same commit). The
  // old guard fired with the selection still at its initial `null`, marked
  // itself "done" regardless, and never retried once the real preference
  // arrived a render later - the track menu showed the right selection
  // (PlayerScreen's own state was always correct) while the <video> kept
  // playing/showing whatever the file's own default was.
  const appliedSubtitleIndexRef = useRef<number | null | undefined>(undefined);
  const appliedAudioIndexRef = useRef<number | null | undefined>(undefined);
  // True once the CURRENT source has reached a genuine in-band-audio
  // readiness checkpoint (`onCanPlay`, or hls.js's `MANIFEST_PARSED`) - see
  // `applyCurrentAudioSelection`'s doc comment for why this must be tracked
  // separately from whether the desired track is already known.
  const audioReadyForInBandRef = useRef(false);
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
  // Subtitle dedup bug fix - see this file's header. Read via ref (not a
  // closure) for the same reason `subtitleTracksRef`/`selectedSubtitleIndexRef`
  // are: `applySubtitle`/`handleSelectSubtitle` are called from DOM event
  // handlers and effects that must always see the LATEST prop value, not
  // whatever was captured when the callback was created.
  const subtitleDeliveryMethodsRef = useRef(subtitleDeliveryMethods);
  subtitleDeliveryMethodsRef.current = subtitleDeliveryMethods;
  const audioTracksRef = useRef(audioTracks);
  audioTracksRef.current = audioTracks;
  const selectedAudioIndexRef = useRef(selectedAudioIndex);
  selectedAudioIndexRef.current = selectedAudioIndex;
  const trackElsRef = useRef<Map<number, HTMLTrackElement>>(new Map());

  const key = sourceKey(source);

  // A new source (different item, or DirectPlay<->Transcoded switch) must
  // reset every per-playback guard/state, or resume-seek and the displayed
  // clock would silently carry over from whatever was playing before.
  //
  // `appliedAudioIndexRef` is DELIBERATELY excluded from this reset, unlike
  // `appliedSubtitleIndexRef`. A source change is not always "unrelated" to
  // audio the way it is to subtitles: `onAudioSwitchUnavailable`'s server
  // re-resolve (the fallback `applyCurrentAudioSelection` falls to) is
  // ITSELF what produces the new `source`/`key` for a Transcoded session.
  // Resetting the guard here used to mean the freshly-reopened source's own
  // `MANIFEST_PARSED` immediately re-evaluated "is this the file's default?"
  // against `audioTracks` (unchanged - it's the same MediaStreams list),
  // concluded "no" again, and re-triggered the exact same fallback -
  // reopening playback from scratch, forever. `selectedAudioIndex` (not
  // `key`) is the right thing to gate on: it only changes for a genuine new
  // pick (manual, or a real item change resets it via PlayerScreen's own
  // `[itemId]` effect, which also fully unmounts/remounts this component -
  // see PlayerScreen.tsx), never merely because THIS component reopened the
  // same target index through a different source.
  useEffect(() => {
    hasSeekedResumeRef.current = false;
    appliedSubtitleIndexRef.current = undefined;
    audioReadyForInBandRef.current = false;
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
   * source. Sideloaded `<track>` elements are the primary mechanism on BOTH
   * paths: Jellyfin serves `Subtitles/{index}/Stream.vtt` for any text
   * subtitle regardless of how the video itself is delivered, whereas its HLS
   * manifest carries no subtitle renditions unless the transcode was asked
   * for them. Restricting the sideload to DirectPlay meant a transcoded
   * stream had NOTHING to show: the menu listed "Español", marked it, and the
   * picture stayed bare - verified with zero `textTracks` on the <video> while
   * the .vtt endpoint returned 200 text/vtt with real Spanish cues.
   * hls.js's own `subtitleTrack` stays as a fallback for the case where the
   * manifest DOES carry renditions and no sideloaded element matched.
   * Still a no-op under native Safari HLS with no hls.js instance. */
  const applySubtitle = (track: MediaStreamTrack | null) => {
    // Subtitle dedup bug fix (this file's header): a burned-in target track
    // is ALREADY visible - baked into the video's pixels - so neither client
    // mechanism has anything to do. Handled FIRST, before the sideload loop,
    // for two reasons: (1) the render list already excludes it from
    // `trackElsRef`, so falling through would see `sideloaded === false` and
    // wrongly try the hls.js branch next; (2) an Encode-delivered subtitle
    // has no HLS text rendition in the manifest at all, so computing its
    // ordinal against the FULL, unfiltered `subtitleTracksRef.current` would
    // misalign against hls.js's own (shorter) `subtitleTracks` array and
    // could select a completely different stream by accident.
    if (track && isBurnedInSubtitle(subtitleDeliveryMethodsRef.current[track.index])) {
      for (const [, el] of trackElsRef.current) {
        if (el.track) el.track.mode = 'disabled';
      }
      if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
      return;
    }

    let sideloaded = false;
    for (const [idx, el] of trackElsRef.current) {
      if (!el.track) continue;
      const on = !!track && idx === track.index;
      el.track.mode = on ? 'showing' : 'disabled';
      if (on) sideloaded = true;
    }
    if (sideloaded || (!track && trackElsRef.current.size > 0)) return;
    if (hlsRef.current) {
      const hls = hlsRef.current;
      if (!track) {
        hls.subtitleTrack = -1;
      } else {
        // Ordinal-match against the SAME filtered list the render uses
        // (burned-in entries excluded) - see the guard above for why the
        // full, unfiltered list would misalign hls.js's own ordinals.
        const nonBurnedIn = subtitleTracksRef.current.filter(
          (t) => !isBurnedInSubtitle(subtitleDeliveryMethodsRef.current[t.index]),
        );
        const ordinal = nonBurnedIn.findIndex((t) => t.index === track.index);
        const hlsTrack = ordinal >= 0 ? hls.subtitleTracks[ordinal] : undefined;
        if (hlsTrack) hls.subtitleTrack = hlsTrack.id;
      }
    }
  };

  /**
   * Re-syncs the <video> to whatever `selectedSubtitleIndex` currently is,
   * reading the latest values via refs so it can be called both from DOM
   * readiness events (below) AND from the props-driven retry effect further
   * down, without either call site going stale. Idempotent - skips if this
   * exact index is already applied - and, critically, does NOT mark itself
   * "applied" when a specific index was requested but its track isn't in
   * `subtitleTracks` yet (mediaStreams still loading): that leaves the door
   * open for the retry effect to apply it for real once the data arrives,
   * instead of silently giving up like the old "once" guard did.
   */
  const applyCurrentSubtitleSelection = () => {
    const idx = selectedSubtitleIndexRef.current;
    if (idx === appliedSubtitleIndexRef.current) return;
    const track = idx == null ? null : (subtitleTracksRef.current.find((t) => t.index === idx) ?? null);
    if (idx != null && !track) return;
    appliedSubtitleIndexRef.current = idx;
    applySubtitle(track);
  };

  /**
   * Attempts to switch audio IN-BAND on the CURRENT source - no server round
   * trip. Shared by the manual pick (`handleSelectAudio`, below) and the
   * initial-restoration effect further down, so restoring a saved
   * preference goes through the exact same "can this browser/hls.js do it
   * without asking the server again" check a manual pick already does,
   * instead of two divergent code paths. Returns whether it actually worked
   * - the caller falls back to `onAudioSwitchUnavailable` (re-resolve
   * `PlaybackInfo` with the picked `AudioStreamIndex`) when it didn't.
   *
   * KNOWN LIMITATION (not fixed by this function): `HTMLMediaElement
   * .audioTracks` does not exist in Chromium at all (confirmed against a
   * real Chromium build - `'audioTracks' in document.createElement('video')`
   * is `false`), despite this file previously claiming "Chrome ships it".
   * For a DirectPlay source, this branch is therefore dead code in Chrome,
   * and the caller falls through to `onAudioSwitchUnavailable` - which is
   * NOT a no-op there anymore: `createBrowserDeviceProfile` (deviceProfile.ts)
   * now declares secondary audio tracks unsupported for DirectPlay, so
   * Jellyfin's `StreamBuilder` refuses to keep the session DirectPlay for
   * one and hands back a real `TranscodingUrl` (video stream-copied) that
   * the fallback's `PlaybackInfo` re-resolve picks up as a genuine
   * `Transcoded` source (see deviceProfile.ts's header for the verified
   * mechanism/cost analysis). What THIS function fixes on top of that:
   * hls.js's in-band switch (`hls.audioTracks`, which genuinely works when a
   * Transcoded session muxes more than one audio rendition) now gets tried
   * on the INITIAL restore too, not just on a manual pick - and the dead
   * DirectPlay branch is at least consistent between both paths instead of
   * only reachable from one of them.
   */
  const attemptInBandAudioSwitch = (track: MediaStreamTrack): boolean => {
    if (source.kind === 'DirectPlay') {
      const webVideo = videoRef.current as unknown as { audioTracks?: BrowserAudioTrackList } | null;
      const list = webVideo?.audioTracks;
      const ordinal = audioTracksRef.current.findIndex((t) => t.index === track.index);
      // `ordinal < 0` means OUR track list and the browser's disagree (e.g.
      // a codec the browser silently dropped) - looping with `i === -1`
      // would match NOTHING and disable every entry, reporting "success"
      // while actually silencing all audio. Treat that as unavailable
      // instead, same as an empty list.
      if (list && list.length > 0 && ordinal >= 0) {
        for (let i = 0; i < list.length; i += 1) list[i].enabled = i === ordinal;
        return true;
      }
      return false;
    }
    if (hlsRef.current && hlsRef.current.audioTracks.length > 1) {
      const ordinal = audioTracksRef.current.findIndex((t) => t.index === track.index);
      const hlsTrack = ordinal >= 0 ? hlsRef.current.audioTracks[ordinal] : undefined;
      if (hlsTrack) {
        hlsRef.current.audioTrack = hlsTrack.id;
        return true;
      }
    }
    return false;
  };

  /**
   * Re-syncs the <video> to whatever `selectedAudioIndex` currently is -
   * mirrors `applyCurrentSubtitleSelection` above and fixes the same class
   * of bug on the audio side. Skips entirely (no callback fired) when the
   * requested track already matches the file's own default: the server
   * already opened on that track, so there is nothing to switch and no
   * reason to spend a `PlaybackInfo` round trip confirming it.
   *
   * `allowFallback` gates the `onAudioSwitchUnavailable` server round trip
   * behind a SEPARATE readiness signal from "do we know which track to
   * pick" (`audioTracksRef`/`selectedAudioIndexRef`, both React-prop-driven):
   * the browser's own `video.audioTracks`/hls.js's `audioTracks` list is
   * typically empty until the media has actually started loading (real
   * `loadedmetadata`/hls `MANIFEST_PARSED` timing) - calling this the moment
   * `source` attaches (see the effect below) would otherwise see an empty
   * list, wrongly conclude in-band switching is unavailable, and burn the
   * one-shot fallback before the browser ever had a chance. Callers at a
   * genuine readiness checkpoint (`onCanPlay`, hls.js `MANIFEST_PARSED`)
   * pass `true`; the too-early call site and the props-driven retry effect
   * pass `false` and simply wait for a readiness checkpoint to re-call this
   * with `true`.
   */
  const applyCurrentAudioSelection = (allowFallback: boolean) => {
    const idx = selectedAudioIndexRef.current;
    if (idx === appliedAudioIndexRef.current) return;
    if (idx == null) {
      appliedAudioIndexRef.current = idx;
      return;
    }
    const tracks = audioTracksRef.current;
    const track = tracks.find((t) => t.index === idx) ?? null;
    if (!track) return; // MediaStreams not loaded yet - retry once `audioTracks` updates.
    const serverDefault = tracks.find((t) => t.isDefault) ?? tracks[0] ?? null;
    if (serverDefault && track.index === serverDefault.index) {
      appliedAudioIndexRef.current = idx;
      return;
    }
    if (attemptInBandAudioSwitch(track)) {
      appliedAudioIndexRef.current = idx;
      onAudioApplied(track);
      return;
    }
    if (!allowFallback) return; // browser/hls.js hasn't had a chance yet - retry at the next readiness checkpoint.
    appliedAudioIndexRef.current = idx;
    onAudioSwitchUnavailable(track);
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
      applyCurrentSubtitleSelection();
      // `false`: too early for `video.audioTracks` to be populated yet (see
      // `applyCurrentAudioSelection`'s doc comment) - `onCanPlay` below is
      // the real readiness checkpoint for this path.
      applyCurrentAudioSelection(false);
      return undefined;
    }

    // Transcoded: server-side HLS.
    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyResumeSeekOnce();
        applyCurrentSubtitleSelection();
        // `true`: hls.js has parsed the multivariant playlist by now, so
        // `hls.audioTracks` (if the transcode muxed more than one) is ready.
        audioReadyForInBandRef.current = true;
        applyCurrentAudioSelection(true);
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

  // Retries the subtitle/audio application whenever the RESOLVED SELECTION
  // itself changes or the track lists grow - this is what actually fixes
  // the "menu shows the right pick, <video> doesn't" bug: `key` alone (the
  // effect above) is ready before PlayerScreen's `useItemMediaStreams` query
  // resolves, so the one-shot apply used to fire with `selectedSubtitleIndex`
  // still `null`. `applyCurrentSubtitleSelection`/`applyCurrentAudioSelection`
  // are idempotent (guarded by `appliedSubtitleIndexRef`/`appliedAudioIndexRef`,
  // which `handleSelectSubtitle`/`handleSelectAudio` also update on a manual
  // pick, for the same reason - otherwise THIS effect would repeat the
  // manual pick's own work a second time right after) and no-op when the
  // desired track isn't in the list YET, so this simply re-fires - cheaply -
  // on every render until the real data lands and it can genuinely apply,
  // instead of giving up after one attempt.
  useEffect(() => {
    applyCurrentSubtitleSelection();
    applyCurrentAudioSelection(audioReadyForInBandRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, selectedSubtitleIndex, subtitleTracks, selectedAudioIndex, audioTracks]);

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
    const applied = attemptInBandAudioSwitch(track);
    // Mark this index as ALREADY decided/attempted before the callbacks
    // below update `selectedAudioIndex` upstream (PlayerScreen). Otherwise
    // the props-driven retry effect fires right after (because
    // `selectedAudioIndex` - and, for the fallback case, `key` too - just
    // changed), sees a "fresh" `appliedAudioIndexRef`, and repeats the exact
    // same attempt a second time - a real, observed bug: one click produced
    // TWO `PlaybackInfo` re-resolves and two `Stopped` reports instead of
    // one.
    appliedAudioIndexRef.current = track.index;
    setActiveMenu(null);
    if (applied) onAudioApplied(track);
    else onAudioSwitchUnavailable(track);
  };

  const handleSelectSubtitle = (track: MediaStreamTrack | null) => {
    setActiveMenu(null);
    const targetIndex = track?.index ?? null;
    // No-op: re-picking the already-active selection (including "Ninguno"
    // twice in a row) - nothing changed, don't spend a round trip.
    if (targetIndex === selectedSubtitleIndexRef.current) return;
    // Subtitle dedup bug fix (this file's header): the CURRENT source has
    // something burned into its video pixels - switching AWAY from it (to a
    // different track, or to "Ninguno") can't be done by toggling a
    // <track>/hls text rendition, since the burned text stays baked into the
    // playing video regardless of what the client shows on top. Only a fresh
    // PlaybackInfo re-resolve (a new `SubtitleStreamIndex`, a new transcode)
    // actually changes what's on screen - the parent's job
    // (`onSubtitleSwitchUnavailable`, mirrors `onAudioSwitchUnavailable`).
    const hasBurnedInSubtitle = Object.values(subtitleDeliveryMethodsRef.current).some(isBurnedInSubtitle);
    if (hasBurnedInSubtitle) {
      onSubtitleSwitchUnavailable(track);
      return;
    }
    applySubtitle(track);
    appliedSubtitleIndexRef.current = targetIndex;
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

  // Subtitle dedup bug fix: never mount a client-side `<track>` for a
  // stream Jellyfin already burned into the video (this file's header) -
  // filtered OUT of the render list entirely, not merely left 'disabled',
  // so it can never end up in `trackElsRef` and never gets toggled
  // 'showing' by mistake. The track menu itself still lists/selects it
  // normally (`subtitleTracks`, unfiltered, feeds `SubtitleTrackMenu`).
  const subtitles = subtitleTracksOf(subtitleTracks).filter(
    (track) => !isBurnedInSubtitle(subtitleDeliveryMethods[track.index]),
  );
  const audios = audioTracksOf(audioTracks);
  const previous = isEpisode ? previousEpisode(episodes, currentEpisodeId) : null;
  const next = isEpisode ? nextEpisode(episodes, currentEpisodeId) : null;

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
          if (source.kind === 'DirectPlay') {
            applyResumeSeekOnce();
            // A DirectPlay `<video>`'s native `audioTracks` list (where a
            // browser supports it at all) is populated once metadata is
            // known, per spec - `loadedmetadata` fires before `canplay` and
            // is an equally valid/earlier readiness checkpoint for it.
            // `canplay` remains the catch-all `applyCurrentAudioSelection`
            // call below in case this event is ever missed.
            audioReadyForInBandRef.current = true;
            applyCurrentAudioSelection(true);
          }
        }}
        onCanPlay={() => {
          applyResumeSeekOnce();
          applyCurrentSubtitleSelection();
          // `true`: canplay is the readiness checkpoint for DirectPlay's
          // native `video.audioTracks` (see doc comment above).
          audioReadyForInBandRef.current = true;
          applyCurrentAudioSelection(true);
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
        {/* Sideloaded on BOTH paths, not just DirectPlay - see `applySubtitle`
            for why the transcoded stream would otherwise have nothing to show. */}
        {subtitles.map((track) => (
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
        ))}
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
            {isEpisode ? (
              <button
                type="button"
                className="pf-player-surface__icon-btn"
                onClick={() => previous && onSelectEpisode(previous.id)}
                disabled={!previous}
                aria-label="Episodio anterior"
              >
                <IconSkipPrevious />
              </button>
            ) : null}

            <button
              type="button"
              className="pf-player-surface__icon-btn"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            >
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>

            {isEpisode ? (
              <button
                type="button"
                className="pf-player-surface__icon-btn"
                onClick={() => next && onSelectEpisode(next.id)}
                disabled={!next}
                aria-label="Episodio siguiente"
              >
                <IconSkipNext />
              </button>
            ) : null}

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

            {isEpisode ? (
              <button
                type="button"
                className="pf-player-surface__icon-btn"
                onClick={() => setActiveMenu('episodes')}
                // `episodes` is empty while `useSeriesEpisodeList` is still
                // loading - disabled rather than opening an empty dialog
                // with nothing but "Cerrar" in it.
                disabled={episodes.length === 0}
                aria-label="Episodios"
                aria-haspopup="dialog"
              >
                <IconEpisodes />
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

      {/* `container={containerRef.current}` (not the OverlayShell default of
          `document.body`) keeps the menu inside this surface: in real
          Fullscreen, `containerRef.current` IS `fullscreenElement` (see
          `toggleFullscreen` above), so the menu renders inside the subtree
          the Fullscreen API actually paints; in pseudo-fullscreen it's the
          `z-index: 9999` surface itself, so the menu - now a DOM descendant
          - is compared against `<video>` and the controls WITHIN that local
          stacking context instead of losing to it from the outside. Fixes a
          real-Chrome audit finding: the menu used to portal to
          `document.body` unconditionally and disappeared entirely in real
          fullscreen, or rendered behind the black video in pseudo-fullscreen. */}
      {activeMenu === 'audio' ? (
        <AudioTrackMenu
          tracks={audioTracks}
          selectedIndex={selectedAudioIndex}
          onSelect={handleSelectAudio}
          onDismiss={() => setActiveMenu(null)}
          container={containerRef.current}
        />
      ) : null}
      {activeMenu === 'subtitle' ? (
        <SubtitleTrackMenu
          tracks={subtitleTracks}
          selectedIndex={selectedSubtitleIndex}
          onSelect={handleSelectSubtitle}
          onDismiss={() => setActiveMenu(null)}
          container={containerRef.current}
        />
      ) : null}
      {activeMenu === 'episodes' ? (
        <EpisodeMenu
          episodes={episodes}
          currentEpisodeId={currentEpisodeId}
          onSelect={(episodeId) => {
            setActiveMenu(null);
            onSelectEpisode(episodeId);
          }}
          onDismiss={() => setActiveMenu(null)}
          token={jellyfinToken ?? null}
          container={containerRef.current}
        />
      ) : null}
    </div>
  );
}
