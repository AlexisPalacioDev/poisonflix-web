import Hls from 'hls.js';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { SubtitleDeliveryMethod } from '../../api/schemas/jellyfin';
import type { PlaybackSource } from '../../lib/domain/streamResolver';
import { languageFamily } from '../../lib/domain/languageNames';
import { getWordHighlightPreference, setWordHighlightPreference } from '../../lib/domain/playerPrefs';
import { audioTracksOf, isBurnedInSubtitle, subtitleTracksOf, trackLabel, type MediaStreamTrack } from './mediaStreamTracks';
import { formatSeekStep, newSeekRun, nextSeekStep, RESET_AFTER_MS } from '../../lib/domain/seekAccelerator';
import {
  activeCueText,
  activeCues,
  activeWordIndex,
  estimateWordTimings,
  parseVttCues,
  tokenizeCueText,
  type SubtitleCue,
} from './subtitleCues';
import { fetchWordTimingsData, resolveWordTimingsForCue, type WordTimingsFile } from './wordTimingsSource';
import { AudioTrackMenu, SubtitleTrackMenu } from './TrackMenu';
import { EpisodeMenu } from './EpisodeMenu';
import { nextEpisode, previousEpisode, type EpisodeNavItem } from './episodeNavigation';
import { playbackIdentity } from './playbackIdentity';
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
//
// ## Dual subtitles (owner request, verbatim: "me gustaría mucho tener 2
// subtítulos al tiempo, ejemplo inglés y español, porque mi intención es
// aprender inglés" - a LANGUAGE-LEARNING feature, not accessibility: read
// English while listening, Spanish alongside for meaning). Scope is
// deliberately narrow - two subtitles rendered at once, remembered per
// language across sessions.
//
// ### Word-level highlight (owner request, verbatim: "resaltar la palabra
// que se está pronunciando" - follow the English audio with your eyes while
// it plays). Applies to WHICHEVER dual-subtitle row is English
// (`languageFamily(track.language) === 'en'`, checked below for both
// `primaryDualTrack` and `secondDualTrack` - the owner could in principle put
// English in either slot) and ONLY that row - see `subtitleCues.ts`'s header
// for why Spanish deliberately never gets word-level highlighting (it's a
// translation, not a transcription: the words/order don't match the audio).
// The non-English row keeps rendering exactly as it did before this feature
// - plain text, no highlighting - which also covers "only Spanish selected,
// no English" (that path doesn't even reach dual mode - see the module-level
// header on `VideoSurface`'s single-subtitle path staying native/untouched).
// Gated behind `wordHighlightEnabled` (persisted via `playerPrefs.ts`,
// default ON, toggled from `SubtitleTrackMenu`'s new "Resaltado de palabra"
// section) and behind having exactly ONE cue active for that row right now
// (`activeCues().length === 1`) - the rare legitimately-overlapping-cues case
// falls back to the same plain joined text `activeCueText` always produced,
// rather than picking one of several active cues to anchor word timing
// against.
//
// - Why NOT two `<track>` elements: this file already sideloads one
//   `<track>` per subtitle stream (`subtitles`, below) and lets the browser
//   paint whichever one has `mode = 'showing'`. Browsers do technically allow
//   more than one track to be `'showing'` at once, but there is no
//   cross-browser contract for HOW two simultaneous cues stack vertically -
//   both default to the same bottom region, so two languages could render on
//   top of each other instead of "English above, Spanish below" (owner's
//   explicit layout ask). Rather than depend on undefined rendering, DUAL
//   mode fetches + parses both VTT files itself (`subtitleCues.ts`) and
//   paints two fixed rows with our own `<div>`s (`pf-player-surface__dual-subtitles`,
//   below) - the SAME approach this file already takes for every other piece
//   of chrome (seek bar, volume, menus), just extended to subtitle text.
// - `selectedSecondSubtitleIndex` is a SEPARATE index from
//   `selectedSubtitleIndex` (the primary) - `null` means dual mode is off,
//   and the primary keeps rendering through the EXACT SAME native `<track>`
//   path as before this change (`syncSubtitles`, `applyCurrentSubtitleSelection`
//   below) - single-subtitle behavior is untouched, not merely "still works
//   by coincidence".
// - Dual mode activates only when BOTH a primary and a second track are
//   selected, they are different streams, and NEITHER is burned in
//   (`DeliveryMethod: 'Encode'` - see `isBurnedInSubtitle`). An Encode stream
//   has no independent text for our overlay to fetch - it is already baked
//   into the transcoded video's pixels (subtitle dedup bug fix, above) - so a
//   pair containing one is explicitly blocked (`TrackMenu.tsx`'s "Segundo
//   subtítulo" section refuses to offer it, with an inline explanation,
//   rather than letting the user create a combination that can't render).
// - While dual mode is active, EVERY native `<track>` is forced to
//   `mode = 'disabled'` and hls.js's own `subtitleTrack` is set to `-1`
//   (`syncSubtitles`) - otherwise the browser would ALSO paint the primary
//   natively underneath our overlay, doubling it exactly like the burned-in
//   dedup bug this file already fixes once.
// - Cue lookup reuses the `currentTime` state this file already updates on
//   every `timeupdate` (no new listener needed) - `subtitleCues.ts`'s
//   `activeCueText` is a pure, cheap array scan, not worth memoizing further
//   for a two-track pair.
// - No AUTO rule for the second subtitle, unlike the primary's (player spec
//   §8): the owner asked for a manual toggle that is REMEMBERED once used
//   (`playerPrefs.ts`'s `resolveInitialSecondSubtitle`), not one that
//   silently turns itself on for someone who never asked for two subtitles.

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

/**
 * Bug fix (owner report, live production evidence - "Backrooms: Sin salida",
 * itemId `19d008d1f5160dfca15e3960b9932b41`): exit-and-reenter reopened the
 * file's own default audio FOREVER, even with a saved preference pointing at
 * a different track and the menu correctly showing it checked.
 *
 * CONFIRMED (structurally, by reading the code and by a red-then-green test,
 * `PlayerScreen.test.tsx` "when neither MANIFEST_PARSED nor canplay ever
 * fires..."): `applyCurrentAudioSelection`'s `allowFallback` gate - the
 * thing that lets the server-round-trip fallback (`onAudioSwitchUnavailable`)
 * actually fire - has EXACTLY THREE ways to become `true`: `onCanPlay`,
 * `onLoadedMetadata` (DirectPlay only), and hls.js's `MANIFEST_PARSED`. None
 * of them is guaranteed to fire within any bounded time, and the
 * props-driven retry effect only ever forwards whatever
 * `audioReadyForInBandRef.current` currently is - it never forces it `true`
 * on its own. IF that trio is ever missed, the saved preference is stuck for
 * the rest of that mount, forever - nothing else in this file ever flips
 * that ref.
 *
 * NOT independently confirmed against the real production browser session
 * (only reproduced in tests, and only against the described symptom, not a
 * live repro): WHY those three events would be missed there. The owner's
 * report noted the `<video>` was PAUSED (autoplay blocked) at the time, and
 * that is the working theory - but checking hls.js's own source
 * (`level-controller.ts`) shows `MANIFEST_PARSED` is driven purely by
 * manifest-file network/parse timing, independent of `<video>.paused` or
 * autoplay state, on the hls.js path (Chrome/Firefox/Edge). A genuinely slow
 * network, a native-HLS Safari session (no `MANIFEST_PARSED` at all - only
 * `canplay`, which IS documented to be deferrable on a paused/backgrounded
 * iOS video), or something else entirely could equally explain a missed
 * checkpoint. This fix does not depend on knowing which - it closes the gap
 * for ALL of them, unconditionally: if nothing else ever supplies a
 * readiness signal, this does, once, bounded.
 *
 * A SEPARATE, equally plausible failure mode exists and is NOT fixed here:
 * `PlayerScreen.tsx`'s `handleAudioSwitchUnavailable` swallows a failed
 * re-resolve in an empty `catch {}`, and `applyCurrentAudioSelection` marks
 * `appliedAudioIndexRef` BEFORE that async call resolves - so a rejected
 * `getPlaybackInfo` (network hiccup, session conflict, anything) would
 * produce the exact same permanently-stuck symptom, and this timer would NOT
 * rescue it either (`appliedAudioIndexRef` already matches by then). Logging
 * that failure (see `PlayerScreen.tsx`) at least makes it observable; a real
 * retry-on-failure is out of scope for this change.
 *
 * This timer is a bounded second chance, not a targeted fix for a fully
 * proven mechanism: started fresh per resolved `source` (cleared on every
 * `key` change/unmount via the effect's cleanup, so it can never fire for a
 * source that's no longer live), it fires AT MOST once, and is a no-op the
 * instant a real readiness event already handled things first
 * (`applyCurrentAudioSelection` is idempotent, guarded by
 * `appliedAudioIndexRef`). It is ALSO skipped entirely once the user has
 * made a manual pick during this component's lifetime
 * (`manualAudioPickRef.current`, set in `handleSelectAudio`) - a passive
 * restore-the-saved-preference safety net must never override an explicit,
 * possibly-still-in-flight user action.
 *
 * Known, accepted tradeoff (NOT eliminated by the above): a real
 * `MANIFEST_PARSED`/`canplay` that is merely slow - not stuck - and would
 * have reported a genuinely different in-band answer (e.g. a Transcoded
 * session that DOES mux more than one audio rendition, the rare case this
 * file's header documents) can still lose a race against this timer if it
 * arrives after `AUDIO_READINESS_FALLBACK_MS`, costing an unnecessary
 * server round trip instead of a free in-band switch. The delay below is
 * deliberately generous (real readiness events normally arrive in well
 * under a second; this is not) to make that window narrow, but "narrow" is
 * not "never" - there is no fixed timeout that is both bounded and race-free
 * against an unbounded wait.
 */
const AUDIO_READINESS_FALLBACK_MS = 4000;

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

/** The exact URL currently attached to the element - a change here means a
 * real reload. Distinct from `playbackIdentity`, which asks the coarser
 * question "is this the same playback?"; see that module for why both exist. */
function sourceKey(source: PlaybackSource): string {
  return source.kind === 'DirectPlay' ? `direct:${source.url}` : `hls:${source.hlsUrl}`;
}

/** The single cue active at `currentTimeSeconds`, or `null` when zero or
 * more than one cue legitimately overlaps - word-highlight rendering only
 * ever anchors to an UNAMBIGUOUS single cue (this file's header, "Word-level
 * highlight" subsection); the rare overlap case falls back to plain text via
 * `activeCueText` instead, same as it always has. */
function soleActiveCue(cues: SubtitleCue[], currentTimeSeconds: number): SubtitleCue | null {
  const active = activeCues(cues, currentTimeSeconds);
  return active.length === 1 ? active[0] : null;
}

interface WordHighlightedLineProps {
  cue: SubtitleCue;
  currentTimeSeconds: number;
  className: string;
  /** The subtitle stream index `cue` was parsed from - the join key against
   * a real-alignment file's own `track` field (`wordTimingsSource.ts`). */
  trackIndex: number;
  /** The current item's real-alignment file, or `null` (not fetched yet, no
   * file exists, or it failed to load - see `wordTimingsSource.ts`'s
   * fallback policy). `null` simply means every cue in this row uses the
   * estimate below - never blocks rendering. */
  wordTimingsFile: WordTimingsFile | null;
}

/**
 * Renders one dual-subtitle row with per-word highlighting (this file's
 * header, "Word-level highlight" subsection - English rows only, gated by
 * the caller before this component is ever used). Tokenizes with
 * `tokenizeCueText` - the SAME tokenizer both `resolveWordTimingsForCue` and
 * `estimateWordTimings` use to produce `timings` - so whitespace/newlines are
 * reproduced verbatim in order (`white-space: pre-line` on
 * `.pf-player-surface__subtitle-line` still turns a `\n` token into a real
 * line break) and only genuine word tokens become highlightable `<span>`s.
 *
 * Timing SOURCE is picked here, once, and nothing below this line cares
 * which one won: real alignment data (`resolveWordTimingsForCue`) when it
 * covers this exact cue and track, else the estimate
 * (`estimateWordTimings`) - see `subtitleCues.ts`'s header for why the
 * estimate is a permanent fallback, not a stopgap.
 */
function WordHighlightedLine({ cue, currentTimeSeconds, className, trackIndex, wordTimingsFile }: WordHighlightedLineProps) {
  const timings = resolveWordTimingsForCue(wordTimingsFile, cue, trackIndex) ?? estimateWordTimings(cue);
  const activeIndex = activeWordIndex(timings, currentTimeSeconds);
  const tokens = tokenizeCueText(cue.text);
  let wordIndex = -1;
  return (
    <p className={className}>
      {tokens.map((token, i) => {
        if (/^\s+$/.test(token)) return token; // whitespace/newline - verbatim, never highlighted
        wordIndex += 1;
        const state = wordIndex < activeIndex ? 'said' : wordIndex === activeIndex ? 'current' : 'upcoming';
        return (
          <span key={i} className={`pf-player-surface__word pf-player-surface__word--${state}`}>
            {token}
          </span>
        );
      })}
    </p>
  );
}

type ActiveMenu = 'audio' | 'subtitle' | 'episodes' | null;

export interface VideoSurfaceProps {
  videoRef: RefObject<HTMLVideoElement>;
  /** The Jellyfin item currently playing - used ONLY to fetch this item's
   * real-alignment word-timings file, if one exists (`wordTimingsSource.ts`,
   * this file's "Real alignment data" header section). Not used for any
   * other purpose here - the media itself is driven entirely by `source`. */
  itemId: string;
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
  /** Second, SIMULTANEOUS subtitle (owner request - see this file's "Dual
   * subtitles" header section). `null` == off; the primary subtitle above is
   * completely unaffected by this prop. */
  selectedSecondSubtitleIndex: number | null;
  /** Fired whenever the second subtitle selection changes (including back to
   * `null`) - purely a client-side apply, never a server round trip (this
   * file's own VTT fetch works the same regardless of DirectPlay/Transcoded,
   * see the header section), so there is no `onSecondSubtitleSwitchUnavailable`
   * counterpart. */
  onSecondSubtitleApplied: (track: MediaStreamTrack | null) => void;
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
  itemId,
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
  selectedSecondSubtitleIndex,
  onSecondSubtitleApplied,
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
  // Set once the user makes an EXPLICIT audio pick (`handleSelectAudio`).
  // Deliberately NOT reset by the per-source `[key]` effect below, unlike
  // `audioReadyForInBandRef`/`appliedSubtitleIndexRef`: an audio switch
  // CREATES a new source, so resetting on `key` would clear the very flag
  // that pick just set. Harmless to keep for later sources, because by then
  // `appliedAudioIndexRef` already matches `selectedAudioIndex` and the
  // safety net short-circuits before ever consulting this.
  // Guards `AUDIO_READINESS_FALLBACK_MS`'s safety-net timer (see that
  // constant's doc comment): without this, a manual pick made WHILE that
  // timer is still pending races it - `handleSelectAudio` marks
  // `appliedAudioIndexRef` with the NEW pick synchronously, but
  // `selectedAudioIndexRef` (React-prop-driven) only catches up once
  // PlayerScreen's own re-resolve promise resolves, so the timer firing in
  // that window would see the OLD `selectedAudioIndexRef` value, wrongly
  // conclude IT hasn't been applied yet, and fire a second, stale
  // `onAudioSwitchUnavailable` for an index the user already moved away
  // from. A passive restore-the-saved-preference safety net must never
  // second-guess an explicit user action - once one happens, this ref stays
  // `true` for the rest of the component's lifetime.
  const manualAudioPickRef = useRef(false);
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
  // Dual subtitles (this file's header) - mirrors `selectedSubtitleIndexRef`
  // for the second slot, read the same way (event handlers/effects need the
  // LATEST value, not a stale closure).
  const selectedSecondSubtitleIndexRef = useRef(selectedSecondSubtitleIndex);
  selectedSecondSubtitleIndexRef.current = selectedSecondSubtitleIndex;
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

  // Dual subtitles (this file's header) - parsed cues for each half of the
  // pair, fetched by the effect further down ONLY while dual mode is active.
  // Kept as full cue arrays (not just "the current line") so the lookup
  // against `currentTime` can reuse the state this file already updates on
  // every `timeupdate`, instead of a second timer/listener.
  const [primaryDualCues, setPrimaryDualCues] = useState<SubtitleCue[]>([]);
  const [secondDualCues, setSecondDualCues] = useState<SubtitleCue[]>([]);

  // Real alignment data (this file's header, "Real alignment data" section) -
  // `null` until (if ever) `fetchWordTimingsData` resolves with a usable
  // file. Fetched unconditionally on every item open, NOT gated behind dual
  // mode or the highlight toggle being on: both can be turned on later
  // mid-playback, and the fetch (cached per item, `wordTimingsSource.ts`)
  // should already be settled by then instead of only starting at that
  // point. Never blocks anything else here - `WordHighlightedLine` simply
  // keeps using the estimate until (if ever) this resolves to non-null.
  const [wordTimingsFile, setWordTimingsFile] = useState<WordTimingsFile | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWordTimingsFile(null); // a new item's data (if any) hasn't arrived yet
    fetchWordTimingsData(itemId).then((file) => {
      if (!cancelled) setWordTimingsFile(file);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // Word-level highlight toggle (this file's "Dual subtitles" header,
  // "Word-level highlight" subsection) - read once from `localStorage` on
  // mount, same lazy-initializer pattern every other localStorage-backed bit
  // of UI state in this codebase uses so the saved preference is honored
  // from the very first render, not applied a tick later.
  const [wordHighlightEnabled, setWordHighlightEnabled] = useState(() => getWordHighlightPreference());
  // The localStorage write is a side effect and belongs in the EVENT
  // HANDLER, not inside a `setState` updater function - this codebase
  // already learned that lesson once (see `AdultPinOverlay.tsx`'s
  // `tryUnlock`/its own doc comment on the same rule): React 18 StrictMode
  // deliberately double-invokes updater functions in development to surface
  // exactly this kind of impurity. Reading `wordHighlightEnabled` from
  // render scope here (rather than a functional updater) is safe - this
  // handler only ever runs in response to a real click, by which point the
  // component has already re-rendered with the latest value.
  const handleToggleWordHighlight = () => {
    const next = !wordHighlightEnabled;
    setWordHighlightEnabled(next);
    setWordHighlightPreference(next);
  };

  // Which source is actually ON the <video> right now. Not always the one
  // the parent just handed down, and that gap is the whole point.
  //
  // Every re-resolve mints a fresh `PlaySessionId`, so `source` arrives with
  // a new URL even when nothing about WHAT is playing changed. Loading it
  // would restart the film for no reason (see `playbackIdentity.ts`). But
  // simply ignoring same-identity URLs is not safe either: re-entering an
  // item with a warm React Query cache renders the PREVIOUS visit's URL
  // first, whose transcode session is long dead on the server, and the
  // refetch that follows is the only thing that can rescue it.
  //
  // So the rule is about whether the session we hold is PROVEN ALIVE, which
  // is exactly what `playing` reports: adopt any new URL until the current
  // one has actually played a frame; after that, only a genuine identity
  // change (different item, media source, audio/subtitle index, delivery
  // mode) is worth an interruption.
  const playbackStartedRef = useRef(false);
  const attachedSourceRef = useRef(source);
  if (
    !playbackStartedRef.current ||
    playbackIdentity(source) !== playbackIdentity(attachedSourceRef.current)
  ) {
    attachedSourceRef.current = source;
  }
  const attachedSource = attachedSourceRef.current;
  const key = sourceKey(attachedSource);

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
  // pick (manual, or a real item change clears it via PlayerScreen's own
  // `[itemId]` effect - which resets state but does NOT unmount this
  // component, contrary to what this comment used to claim: PlayerScreen
  // passes no `key` to `<VideoSurface>` and navigates between episodes with
  // `replace`, so the element survives), never merely because THIS component
  // reopened the same target index through a different source.
  useEffect(() => {
    hasSeekedResumeRef.current = false;
    appliedSubtitleIndexRef.current = undefined;
    audioReadyForInBandRef.current = false;
    // Whatever is about to be attached has proven nothing yet - see
    // `playbackStartedRef`'s declaration above.
    playbackStartedRef.current = false;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setActiveMenu(null);
    // Dual subtitles (this file's header): without this, a source change
    // (episode prev/next, or an audio/subtitle switch re-resolve - both keep
    // this component mounted, only `key` changes) would leave the PREVIOUS
    // source's parsed cues in state until the new fetch resolves, flashing
    // stale text over the new video for a frame. The cue-fetching effect
    // below re-populates these the moment it has a fresh answer; this just
    // guarantees the gap in between is blank, not wrong.
    setPrimaryDualCues([]);
    setSecondDualCues([]);
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
   * Dual subtitles (this file's header): true only when BOTH a primary and a
   * second subtitle are selected, they are different streams, and NEITHER is
   * burned in. Reads every input via ref so it stays correct when called
   * from a DOM readiness event whose closure was created on an earlier
   * render (same reasoning as `applyCurrentSubtitleSelection` above).
   */
  const isDualSubtitleActive = (): boolean => {
    const primaryIdx = selectedSubtitleIndexRef.current;
    const secondIdx = selectedSecondSubtitleIndexRef.current;
    if (primaryIdx == null || secondIdx == null || primaryIdx === secondIdx) return false;
    const methods = subtitleDeliveryMethodsRef.current;
    if (isBurnedInSubtitle(methods[primaryIdx]) || isBurnedInSubtitle(methods[secondIdx])) return false;
    return true;
  };

  /**
   * Single entry point every call site below uses to keep the <video>'s
   * subtitle rendering in sync - replaces every direct
   * `applyCurrentSubtitleSelection()` call this file had before dual
   * subtitles existed. When dual mode is OFF (the default - `null` second
   * selection, exactly today's behavior) it does exactly what it always did:
   * delegates straight to `applyCurrentSubtitleSelection`. When dual mode is
   * ON, it does the OPPOSITE of that function on purpose: forces every
   * native `<track>` to `'disabled'` and hls.js's `subtitleTrack` to `-1`,
   * because BOTH lines are about to be painted by this component's own
   * overlay (`pf-player-surface__dual-subtitles` in the JSX below) - letting
   * the browser ALSO render the primary natively here would double it, the
   * exact same failure shape as the burned-in dedup bug this file already
   * fixes once (see the header). `appliedSubtitleIndexRef` is still updated
   * so a later exit from dual mode (second subtitle turned back off) is
   * recognized by `applyCurrentSubtitleSelection` as "not yet applied for
   * real" and re-shows the primary natively - see that transition's own note
   * on `appliedSubtitleIndexRef.current = undefined` two lines below.
   */
  const syncSubtitles = () => {
    if (!isDualSubtitleActive()) {
      applyCurrentSubtitleSelection();
      return;
    }
    for (const [, el] of trackElsRef.current) {
      if (el.track) el.track.mode = 'disabled';
    }
    if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
    // Deliberately the OPPOSITE of `applyCurrentSubtitleSelection`'s own
    // bookkeeping: reset to `undefined` ("nothing applied for THIS source
    // yet") rather than marking the primary index as applied. Every native
    // `<track>` was just forced 'disabled' above, so - unlike the normal
    // single-subtitle path - the primary is NOT actually showing right now.
    // Leaving `appliedSubtitleIndexRef` at its old value would make
    // `applyCurrentSubtitleSelection` think its work is already done the
    // moment dual mode turns back off (second subtitle -> null) and skip
    // re-enabling the native track entirely, leaving the primary subtitle
    // silently blank.
    appliedSubtitleIndexRef.current = undefined;
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
    if (attachedSource.kind === 'DirectPlay') {
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

    // Readiness-checkpoint safety net - see `AUDIO_READINESS_FALLBACK_MS`'s
    // doc comment for the full root-cause story. Started for EVERY source
    // (DirectPlay included, for the same reason `onLoadedMetadata`/`onCanPlay`
    // already cover DirectPlay too - a paused, autoplay-blocked <video> isn't
    // exclusive to the HLS path) and always cleared below. Skips entirely
    // once the user has made a manual pick for this source
    // (`manualAudioPickRef` - see its own doc comment): this is a passive
    // restore-the-saved-preference mechanism and must never second-guess an
    // explicit, possibly-still-in-flight user action.
    const readinessSafetyNet = window.setTimeout(() => {
      if (manualAudioPickRef.current) return;
      audioReadyForInBandRef.current = true;
      applyCurrentAudioSelection(true);
    }, AUDIO_READINESS_FALLBACK_MS);

    if (attachedSource.kind === 'DirectPlay') {
      video.src = attachedSource.url;
      syncSubtitles();
      // `false`: too early for `video.audioTracks` to be populated yet (see
      // `applyCurrentAudioSelection`'s doc comment) - `onCanPlay` below is
      // the real readiness checkpoint for this path.
      applyCurrentAudioSelection(false);
      return () => window.clearTimeout(readinessSafetyNet);
    }

    // Transcoded: server-side HLS.
    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyResumeSeekOnce();
        syncSubtitles();
        // `true`: hls.js has parsed the multivariant playlist by now, so
        // `hls.audioTracks` (if the transcode muxed more than one) is ready.
        audioReadyForInBandRef.current = true;
        applyCurrentAudioSelection(true);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onError();
      });
      hls.loadSource(attachedSource.hlsUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari) - no hls.js instance to manage; audio/subtitle
      // switching is unavailable on this path (see file header).
      video.src = attachedSource.hlsUrl;
    } else {
      onUnsupported();
    }

    return () => {
      window.clearTimeout(readinessSafetyNet);
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
    syncSubtitles();
    applyCurrentAudioSelection(audioReadyForInBandRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    key,
    selectedSubtitleIndex,
    subtitleTracks,
    selectedAudioIndex,
    audioTracks,
    // Dual subtitles (this file's header): the second slot changing (on, off,
    // or a different language) must re-run the same sync - it flips whether
    // the native track stays disabled (dual mode) or comes back (single
    // mode).
    selectedSecondSubtitleIndex,
  ]);

  // Dual subtitles (this file's header): derived once per render from props
  // directly - reused by BOTH the cue-fetching effect right below and the
  // overlay JSX further down, so the two can never disagree about whether
  // dual mode is active. Unlike the imperative helpers above (`syncSubtitles`
  // etc.), nothing here runs inside a DOM event handler or a closure that
  // could go stale, so the plain render-scoped value is exactly what's
  // wanted - no ref needed.
  const primaryDualTrack =
    selectedSubtitleIndex == null ? null : (subtitleTracks.find((t) => t.index === selectedSubtitleIndex) ?? null);
  const secondDualTrack =
    selectedSecondSubtitleIndex == null
      ? null
      : (subtitleTracks.find((t) => t.index === selectedSecondSubtitleIndex) ?? null);
  const dualSubtitlesActive = Boolean(
    primaryDualTrack &&
      secondDualTrack &&
      primaryDualTrack.index !== secondDualTrack.index &&
      !isBurnedInSubtitle(subtitleDeliveryMethods[primaryDualTrack.index]) &&
      !isBurnedInSubtitle(subtitleDeliveryMethods[secondDualTrack.index]),
  );

  // Fetches + parses both VTT files ONLY while dual mode is active (this
  // file's header explains why native `<track>` rendering isn't trusted for
  // two simultaneous languages). Reuses `buildSubtitleUrl` - the SAME
  // url-builder the native sideload below already uses - so this hits the
  // exact same server endpoint rather than inventing a second one.
  useEffect(() => {
    if (!dualSubtitlesActive || !primaryDualTrack || !secondDualTrack) {
      setPrimaryDualCues([]);
      setSecondDualCues([]);
      return undefined;
    }
    let cancelled = false;
    const primaryUrl = buildSubtitleUrl(primaryDualTrack);
    const secondUrl = buildSubtitleUrl(secondDualTrack);
    Promise.all([fetch(primaryUrl).then((r) => r.text()), fetch(secondUrl).then((r) => r.text())])
      .then(([primaryText, secondText]) => {
        if (cancelled) return;
        setPrimaryDualCues(parseVttCues(primaryText));
        setSecondDualCues(parseVttCues(secondText));
      })
      .catch(() => {
        // Best-effort: never let a subtitle-fetch failure (network hiccup,
        // CORS, a malformed VTT) break playback - same policy as every other
        // subtitle path in this file. Falls back to no overlay text; the
        // video keeps playing regardless.
        if (cancelled) return;
        setPrimaryDualCues([]);
        setSecondDualCues([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dualSubtitlesActive, primaryDualTrack?.index, secondDualTrack?.index, key]);

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
    // No-op: re-picking the track that is ALREADY playing, the same guard
    // `handleSelectSubtitle` has had all along (the menu marks the active
    // entry but does not disable it, so this is one stray click away).
    //
    // Without it, the click fell through to `onAudioSwitchUnavailable` -
    // Chromium has no `video.audioTracks`, so the in-band attempt always
    // fails - and PlayerScreen re-resolved PlaybackInfo with the SAME
    // `AudioStreamIndex`. The reply is byte-identical except for a fresh
    // `PlaySessionId`, which `attachedSourceRef` (correctly) now refuses to
    // reload for. That left the parent holding a `playSessionId`,
    // `subtitleDeliveryMethods` and heartbeat describing a transcode session
    // nobody ever opened, while the element kept playing the previous one.
    // Not reloading was right; asking the server at all was the mistake.
    if (track.index === selectedAudioIndexRef.current) {
      setActiveMenu(null);
      return;
    }
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
    // See `manualAudioPickRef`'s doc comment - an explicit pick permanently
    // disarms the passive readiness-fallback safety net for this source, so
    // it can never race this pick's own still-in-flight fallback.
    manualAudioPickRef.current = true;
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
    // Dual subtitles (this file's header): if a second subtitle is ALSO
    // active, picking a new primary here must not call `applySubtitle`
    // directly - that would flip the new track's native `<track>` to
    // 'showing' for one paint before the retry effect's `syncSubtitles` (which
    // reacts to `selectedSubtitleIndex` via `onSubtitleApplied` below) catches
    // up and disables it again, a visible flash of the browser's own
    // rendering underneath our overlay. Leaving `appliedSubtitleIndexRef`
    // unset lets that effect do the ONE correct disable-everything pass
    // instead of this handler doing a now-wrong 'showing' pass first.
    const secondIdx = selectedSecondSubtitleIndexRef.current;
    const willStayDual =
      secondIdx != null &&
      targetIndex != null &&
      targetIndex !== secondIdx &&
      !isBurnedInSubtitle(subtitleDeliveryMethodsRef.current[targetIndex]) &&
      !isBurnedInSubtitle(subtitleDeliveryMethodsRef.current[secondIdx]);
    if (willStayDual) {
      appliedSubtitleIndexRef.current = undefined;
    } else {
      applySubtitle(track);
      appliedSubtitleIndexRef.current = targetIndex;
    }
    onSubtitleApplied(track);
  };

  /**
   * Dual subtitles (this file's header): picking the SECOND slot is purely a
   * client-side apply, unlike `handleSelectSubtitle` above - there is no
   * `onSecondSubtitleSwitchUnavailable` counterpart because there is nothing
   * for a `PlaybackInfo` re-resolve to fix here: the cue-loading effect below
   * fetches the plain `Stream.vtt` endpoint directly, which works the same
   * way regardless of DirectPlay/Transcoded (see the header's "Dual
   * subtitles" section). `syncSubtitles`/the retry effect (keyed on
   * `selectedSecondSubtitleIndex`) do the actual rendering work; this
   * handler only closes the menu and reports the pick upward so
   * `PlayerScreen` can persist it.
   */
  const handleSelectSecondSubtitle = (track: MediaStreamTrack | null) => {
    setActiveMenu(null);
    const targetIndex = track?.index ?? null;
    if (targetIndex === selectedSecondSubtitleIndexRef.current) return; // no-op: re-picking the active selection
    onSecondSubtitleApplied(track);
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

  // Dual subtitles (this file's header): the currently active line for each
  // half of the pair, looked up from the parsed cue arrays against
  // `currentTime` - the SAME state this file already updates on every
  // `timeupdate`, so no extra listener/timer is needed just for this.
  const primaryCueText = dualSubtitlesActive ? activeCueText(primaryDualCues, currentTime) : null;
  const secondCueText = dualSubtitlesActive ? activeCueText(secondDualCues, currentTime) : null;

  // Word-level highlight (this file's header, "Word-level highlight"
  // subsection): a row is eligible only when dual mode is active, the
  // toggle is on, ITS OWN track is English, and exactly one cue is active
  // right now to unambiguously anchor word timing against. `null` here means
  // "render this row as plain text" - the JSX below falls back to that
  // automatically, so this never needs its own on/off branch beyond the ternary.
  const primaryHighlightCue =
    dualSubtitlesActive && wordHighlightEnabled && languageFamily(primaryDualTrack?.language ?? null) === 'en'
      ? soleActiveCue(primaryDualCues, currentTime)
      : null;
  const secondHighlightCue =
    dualSubtitlesActive && wordHighlightEnabled && languageFamily(secondDualTrack?.language ?? null) === 'en'
      ? soleActiveCue(secondDualCues, currentTime)
      : null;

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
          if (attachedSource.kind === 'DirectPlay') {
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
          syncSubtitles();
          // `true`: canplay is the readiness checkpoint for DirectPlay's
          // native `video.audioTracks` (see doc comment above).
          audioReadyForInBandRef.current = true;
          applyCurrentAudioSelection(true);
        }}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        // `playing`, NOT `play`: `play` only means someone called `.play()`,
        // which a dead transcode session answers just as readily as a live
        // one. `playing` means frames are actually coming out. That is the
        // proof `attachedSourceRef` waits for before it stops accepting
        // replacement URLs - see its declaration.
        onPlaying={() => {
          playbackStartedRef.current = true;
        }}
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

      {/* Dual subtitles (this file's header, owner request: read English
          while listening, Spanish alongside for meaning). A sibling of
          `.pf-player-surface__controls`, not a child of it - the two lines
          must stay readable regardless of whether the controls' opacity
          fade is currently hiding them. `aria-hidden`: this duplicates
          information already available via the (disabled, for dual mode)
          native `<track>` elements' own accessible text; a second live
          region would just double-announce the same captions to a screen
          reader. `--raised` pushes the block up when the control bar is
          visible so the bottom line never sits under the seek/volume row -
          "no deben tapar los controles" (owner requirement). */}
      {dualSubtitlesActive ? (
        <div
          className={`pf-player-surface__dual-subtitles${
            controlsVisible ? ' pf-player-surface__dual-subtitles--raised' : ''
          }`}
          aria-hidden="true"
        >
          {primaryCueText ? (
            primaryHighlightCue ? (
              <WordHighlightedLine
                cue={primaryHighlightCue}
                currentTimeSeconds={currentTime}
                className="pf-player-surface__subtitle-line pf-player-surface__subtitle-line--primary"
                trackIndex={primaryDualTrack?.index ?? -1}
                wordTimingsFile={wordTimingsFile}
              />
            ) : (
              <p className="pf-player-surface__subtitle-line pf-player-surface__subtitle-line--primary">
                {primaryCueText}
              </p>
            )
          ) : null}
          {secondCueText ? (
            secondHighlightCue ? (
              <WordHighlightedLine
                cue={secondHighlightCue}
                currentTimeSeconds={currentTime}
                className="pf-player-surface__subtitle-line pf-player-surface__subtitle-line--second"
                trackIndex={secondDualTrack?.index ?? -1}
                wordTimingsFile={wordTimingsFile}
              />
            ) : (
              <p className="pf-player-surface__subtitle-line pf-player-surface__subtitle-line--second">
                {secondCueText}
              </p>
            )
          ) : null}
        </div>
      ) : null}

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
          secondSelectedIndex={selectedSecondSubtitleIndex}
          onSelectSecond={handleSelectSecondSubtitle}
          subtitleDeliveryMethods={subtitleDeliveryMethods}
          wordHighlightEnabled={wordHighlightEnabled}
          onToggleWordHighlight={handleToggleWordHighlight}
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
