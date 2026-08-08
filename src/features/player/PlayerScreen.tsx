import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getPlaybackInfo, reportStopped } from '../../api/jellyfin';
import type { SubtitleDeliveryMethod } from '../../api/schemas/jellyfin';
import { useAuth } from '../../hooks/useAuth';
import { usePlaybackHeartbeat } from '../../hooks/usePlaybackHeartbeat';
import { usePlaybackInfo } from '../../hooks/usePlaybackInfo';
import { createBrowserDeviceProfile } from '../../lib/domain/deviceProfile';
import { isApiError } from '../../lib/http/errors';
import { reportFailure } from '../../lib/obs/report';
import {
  audioPreferenceKeyFor,
  resolveInitialAudio,
  resolveInitialSecondSubtitle,
  resolveInitialSubtitle,
  secondSubtitlePreferenceKeyFor,
  setAudioPreference,
  setSecondSubtitlePreference,
  setSubtitlePreference,
  subtitlePreferenceKeyFor,
} from '../../lib/domain/playerPrefs';
import { resolvePlayback, secondsToTicks, type PlaybackSource } from '../../lib/domain/streamResolver';
import { audioTracksOf, buildSubtitleDeliveryUrl, subtitleTracksOf, useItemMediaStreams, type MediaStreamTrack } from './mediaStreamTracks';
import { useSeriesEpisodeList } from './episodeNavigation';
import { VideoSurface } from './VideoSurface';
import './player.css';

// Player screen (design.md §7 `/player/:id`, player spec, tasks.md 7.5),
// ported from `PlayerScreen.kt` + `PlaybackController.kt`. `:id` is the
// Jellyfin item id (design.md §7) - Detail's "Reproducir" action already
// resolves the InLibrary item's real Jellyfin id before navigating here, so
// no id-shape translation happens in this screen.
//
// Both `PlaybackSource` variants now play: DirectPlay via native `<video>`,
// Transcoded via `<VideoSurface>`'s hls.js/native-HLS handling. Error
// messages are deliberately distinguished by root cause instead of one
// catch-all string:
// - `usePlaybackInfo` fetch failure with a real 401 -> session/auth message.
// - Any other fetch failure (network/PlaybackInfo) -> load-failure message.
// - Neither hls.js nor native HLS available for a Transcoded source (a
//   genuinely rare browser-capability gap) -> explicit "can't play this
//   video" message, via `onUnsupported`.
// - The `<video>`/hls.js element itself fires a fatal error mid-playback ->
//   a playback-specific message, not the fetch-failure one.
//
// ## Audio/subtitle track menus (player spec §8, projector-feature-map.md §8)
// `useItemMediaStreams` fetches the item's `MediaStreams` a second time
// (see that hook's own header for why - `usePlaybackInfo`/`getItem` are out
// of this change's touchable-files list). This screen owns:
// - The initial audio/subtitle SELECTION (default audio track, and
//   `resolveInitialSubtitle`'s saved-preference/AUTO rule) - `VideoSurface`
//   only ever applies whatever index it's handed.
// - `handleAudioSwitchUnavailable`: the `switchAudioUnderTranscode` port -
//   re-resolves `PlaybackInfo` with the picked `AudioStreamIndex` and
//   reopens `VideoSurface` at the saved position, reporting the OLD
//   PlaySessionId `Stopped` first so Jellyfin doesn't accumulate ghost
//   sessions (mirrors `PlayerViewModel.openResolved`'s same guard).
// - Persisting the user's subtitle choice (`setSubtitlePreference`).
// - `selectedSecondSubtitleIndex`/`handleSecondSubtitleApplied`: the SAME
//   split (screen decides + persists, `VideoSurface` applies) for the
//   second, SIMULTANEOUS subtitle (owner request - see `VideoSurface.tsx`'s
//   "Dual subtitles" header section for the rendering approach). Resolved
//   from its own saved preference only (`resolveInitialSecondSubtitle`) -
//   no AUTO rule, no server round trip on switch, unlike audio/the primary
//   subtitle above.
//
// ## Episode prev/next/jump navigation (owner request)
// `data.type`/`data.seriesId` (from `usePlaybackInfo`) gate `episodeNavigation.ts`'s
// `useSeriesEpisodeList` - only fetched for `Episode` items, never for a
// movie. `handleNavigateToEpisode` uses `navigate(..., { replace: true })`,
// not a normal push: prev/next/jump can be pressed many times in one
// session, and a growing history stack would mean "Volver" has to be
// pressed once per episode watched instead of once to leave the player -
// `replace` keeps a single player entry in history no matter how many
// episodes were played from it.

const APP_LANGUAGE = 'es';

export function PlayerScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const itemId = id ?? '';
  const { session } = useAuth();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [playbackUnsupported, setPlaybackUnsupported] = useState(false);

  const { data, isLoading, isError, error } = usePlaybackInfo(itemId);
  const mediaStreams = useItemMediaStreams(itemId, session?.jellyfinUserId ?? '');
  const audioTracks = mediaStreams.data ? audioTracksOf(mediaStreams.data) : [];
  const subtitleTracks = mediaStreams.data ? subtitleTracksOf(mediaStreams.data) : [];

  // Episode prev/next/jump navigation (player spec: only for `Episode`
  // items - a movie has no siblings, so the series-id fed to the query stays
  // `null` and the query never fires, per react-query's `enabled`).
  const isEpisode = data?.type === 'Episode';
  const seriesEpisodes = useSeriesEpisodeList(isEpisode ? (data?.seriesId ?? null) : null, session?.jellyfinUserId ?? '');

  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  // Second, SIMULTANEOUS subtitle (owner request, verbatim: "me gustaría
  // poder leer también los sub en inglés y en español" - a language-learning
  // feature, not accessibility). `null` == off; entirely independent state
  // from `selectedSubtitleIndex` above, exactly like audio/subtitle already
  // are independent of each other - see `VideoSurface.tsx`'s "Dual
  // subtitles" header section for the full design rationale (why this is
  // rendered by a custom overlay instead of a second `<track>`).
  const [selectedSecondSubtitleIndex, setSelectedSecondSubtitleIndex] = useState<number | null>(null);
  // Mirrors the state above so an ASYNC re-resolve reads the subtitle pick as
  // it is WHEN THE REQUEST GOES OUT, not as it was in the render that created
  // the callback. `handleAudioSwitchUnavailable` can be invoked from a
  // timer/event whose closure was captured while this was still `null`, and
  // it forwards the value to the server as `subtitleStreamIndex`: a stale
  // `null` becomes `-1`, which Jellyfin reads as "no subtitles at all". An
  // audio switch would then silently strip the auto-selected subtitle while
  // the menu kept showing it ticked - the same lie-to-the-user shape as the
  // bugs this screen has already been through. Written on every render (no
  // dep array) because the only thing that matters is that it is current.
  const selectedSubtitleIndexRef = useRef<number | null>(null);
  useEffect(() => {
    selectedSubtitleIndexRef.current = selectedSubtitleIndex;
  });
  const [subtitleResolved, setSubtitleResolved] = useState(false);

  /** Set once EITHER an audio switch (`handleAudioSwitchUnavailable`) OR a
   * subtitle switch away from a burned-in stream
   * (`handleSubtitleSwitchUnavailable`) has re-resolved `PlaybackInfo` -
   * overrides the base `data.resolved` source/resume position/subtitle
   * delivery map until the next switch (or item change). Shared by both,
   * not split into two, because either one produces a genuinely NEW
   * resolved session (fresh `TranscodingUrl`/`PlaySessionId`/subtitle
   * DeliveryMethod map) that every downstream consumer (`heartbeat`,
   * `<VideoSurface>`'s `source`, the burned-in-subtitle prop) must read from
   * in one place, not two potentially-stale ones. */
  const [playbackOverride, setPlaybackOverride] = useState<{
    source: PlaybackSource;
    resumeSeconds: number;
    mediaSourceId: string;
    playSessionId: string | null;
    subtitleDeliveryMethods: Record<number, SubtitleDeliveryMethod>;
  } | null>(null);

  // Resets every per-item guard when navigating to a different item.
  useEffect(() => {
    setSelectedAudioIndex(null);
    setSelectedSubtitleIndex(null);
    setSelectedSecondSubtitleIndex(null);
    setSubtitleResolved(false);
    setPlaybackOverride(null);
  }, [itemId]);

  // Once MediaStreams are known, resolve which audio/subtitle index the
  // player SHOULD open on (saved preference -> language match -> AUTO rule,
  // player spec §8). This effect only decides the index; actually making it
  // real on the <video> is `VideoSurface`'s job (its own initial-apply
  // effects, keyed on `selectedAudioIndex`/`selectedSubtitleIndex`), the
  // exact same machinery a manual TrackMenu pick goes through
  // (`handleSelectAudio`/`applySubtitle`). This used to call
  // `handleAudioSwitchUnavailable` directly and unconditionally right here
  // whenever the resolved audio differed from the file's own default -
  // which skipped the in-band `HTMLMediaElement.audioTracks`/hls.js attempt
  // entirely, the ONE mechanism that can make a DirectPlay/HLS audio switch
  // actually audible without a server round trip. Splitting "decide" from
  // "apply" here keeps the initial restore and the manual pick on one path
  // instead of two, so a fix to one can't silently diverge from the other.
  useEffect(() => {
    if (!mediaStreams.data) return;
    const preferredAudio = resolveInitialAudio(audioTracks);
    if (selectedAudioIndex == null && preferredAudio) {
      setSelectedAudioIndex(preferredAudio.index);
    }
    const defaultAudio = preferredAudio;
    if (!subtitleResolved) {
      const initial = resolveInitialSubtitle(subtitleTracks, defaultAudio?.language ?? null, APP_LANGUAGE);
      setSelectedSubtitleIndex(initial?.index ?? null);
      // Second subtitle (owner request - see the state declaration above):
      // resolved from ITS OWN saved preference only, never the AUTO rule
      // (`resolveInitialSecondSubtitle`'s own doc comment explains why) -
      // gated on `subtitleResolved` alongside the primary so both settle
      // together, in the same pass, exactly once per item.
      const secondInitial = resolveInitialSecondSubtitle(subtitleTracks, initial?.index ?? null);
      setSelectedSecondSubtitleIndex(secondInitial?.index ?? null);
      setSubtitleResolved(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaStreams.data]);

  const heartbeat = usePlaybackHeartbeat({
    itemId,
    playSessionId: playbackOverride?.playSessionId ?? data?.resolved.playSessionId ?? null,
    getPositionSeconds: () => videoRef.current?.currentTime ?? 0,
  });

  const handleBack = () => navigate(-1);

  // `replace: true` - see this file's header comment for why prev/next/jump
  // must not grow the history stack.
  const handleNavigateToEpisode = (episodeId: string) => {
    if (episodeId === itemId) return;
    navigate(`/player/${episodeId}`, { replace: true });
  };

  const handleAudioApplied = (track: MediaStreamTrack) => {
    setSelectedAudioIndex(track.index);
    setAudioPreference(audioPreferenceKeyFor(track));
  };

  /**
   * `switchAudioUnderTranscode` port: neither the browser's `audioTracks`
   * API nor hls.js's in-band audio switching was available for the current
   * mode - the only remaining path is asking Jellyfin to re-transcode with
   * a specific `AudioStreamIndex` and reopening at the saved position.
   */
  const handleAudioSwitchUnavailable = async (track: MediaStreamTrack) => {
    if (!session || !data) return;
    const positionSeconds = videoRef.current?.currentTime ?? 0;
    const previousSession = playbackOverride?.playSessionId ?? data.resolved.playSessionId;
    try {
      const playbackInfo = await getPlaybackInfo(itemId, {
        userId: session.jellyfinUserId,
        deviceProfile: createBrowserDeviceProfile(),
        // Required for `audioStreamIndex` below to have any effect at all -
        // see `GetPlaybackInfoBody.mediaSourceId`'s doc comment (jellyfin.ts).
        mediaSourceId: playbackOverride?.mediaSourceId ?? data.resolved.mediaSourceId,
        audioStreamIndex: track.index,
        // Carries the CURRENT subtitle pick through the re-resolve (`-1` for
        // "Ninguno") - without this, an audio switch would silently hand the
        // decision back to the server's own default subtitle, possibly
        // changing (or re-adding) whatever the user had picked/turned off.
        // Read from the ref, never the closure: see its declaration for why a
        // stale `null` here would tell the server to drop subtitles entirely.
        subtitleStreamIndex: selectedSubtitleIndexRef.current ?? -1,
      });
      const resolved = resolvePlayback(itemId, playbackInfo, session.jellyfinToken);
      if (previousSession && previousSession !== resolved.playSessionId) {
        void reportStopped({
          itemId,
          playSessionId: previousSession,
          positionTicks: secondsToTicks(positionSeconds),
        });
      }
      setPlaybackOverride({
        source: resolved.source,
        resumeSeconds: positionSeconds,
        mediaSourceId: resolved.mediaSourceId,
        playSessionId: resolved.playSessionId,
        subtitleDeliveryMethods: resolved.subtitleDeliveryMethods,
      });
      setSelectedAudioIndex(track.index);
      setAudioPreference(audioPreferenceKeyFor(track));
    } catch (error) {
      // Best-effort: leave current playback untouched if the re-resolve
      // fails. NOT a fix for the exit-and-reenter audio-restore bug
      // (VideoSurface.tsx's `AUDIO_READINESS_FALLBACK_MS` doc comment) - a
      // failure here is a SEPARATE, equally plausible way to produce the
      // exact same "saved preference never makes it to the stream" symptom,
      // since `VideoSurface` already marks its own `appliedAudioIndexRef`
      // before this promise settles and has no way to know it failed. Was a
      // fully silent `catch {}` before (see `lib/obs/report.ts`'s header for
      // why that pattern is a known problem in this codebase) - reporting it
      // at least makes a real failure here distinguishable (during triage)
      // from the readiness-gate bug the timer fixes, instead of both looking
      // identical from the outside.
      reportFailure('player.audioSwitchUnavailable', error, { itemId, audioStreamIndex: track.index });
    }
  };

  const handleSubtitleApplied = (track: MediaStreamTrack | null) => {
    setSelectedSubtitleIndex(track?.index ?? null);
    setSubtitlePreference(subtitlePreferenceKeyFor(track));
  };

  /** Second subtitle (owner request - see the state declaration above).
   * Always a pure client-side apply on `VideoSurface`'s side (no server
   * round trip possible for this slot), so - unlike audio/the primary
   * subtitle - there is no `SwitchUnavailable` counterpart to handle here. */
  const handleSecondSubtitleApplied = (track: MediaStreamTrack | null) => {
    setSelectedSecondSubtitleIndex(track?.index ?? null);
    setSecondSubtitlePreference(secondSubtitlePreferenceKeyFor(track));
  };

  /**
   * Subtitle dedup bug fix, part 2 (`onSubtitleSwitchUnavailable` -
   * VideoSurface.tsx's header): the CURRENT source has a subtitle burned
   * into its pixels, so switching away from it (a different track, or
   * "Ninguno") cannot be done by toggling a client-side `<track>` - the
   * server must re-transcode WITHOUT that burn-in. Mirrors
   * `handleAudioSwitchUnavailable` exactly: re-resolve `PlaybackInfo` with
   * the new `SubtitleStreamIndex` (`-1` for "none" - Jellyfin convention,
   * verified against jellyfin/jellyfin v10.11.11's `StreamBuilder`: an
   * explicit `-1` is a real value that skips the file's-own-default
   * fallback, unlike omitting the field entirely), report the OLD
   * PlaySessionId `Stopped` first, and reopen at the saved position.
   */
  const handleSubtitleSwitchUnavailable = async (track: MediaStreamTrack | null) => {
    if (!session || !data) return;
    const positionSeconds = videoRef.current?.currentTime ?? 0;
    const previousSession = playbackOverride?.playSessionId ?? data.resolved.playSessionId;
    try {
      const playbackInfo = await getPlaybackInfo(itemId, {
        userId: session.jellyfinUserId,
        deviceProfile: createBrowserDeviceProfile(),
        // Required for `subtitleStreamIndex`/`audioStreamIndex` below to have
        // any effect at all - see `GetPlaybackInfoBody.mediaSourceId`'s doc
        // comment (jellyfin.ts).
        mediaSourceId: playbackOverride?.mediaSourceId ?? data.resolved.mediaSourceId,
        // Carries the CURRENT audio pick through the re-resolve, same
        // reasoning as `handleAudioSwitchUnavailable` carrying the subtitle
        // one - a subtitle-only switch must not silently reset audio.
        audioStreamIndex: selectedAudioIndex ?? undefined,
        subtitleStreamIndex: track?.index ?? -1,
      });
      const resolved = resolvePlayback(itemId, playbackInfo, session.jellyfinToken);
      if (previousSession && previousSession !== resolved.playSessionId) {
        void reportStopped({
          itemId,
          playSessionId: previousSession,
          positionTicks: secondsToTicks(positionSeconds),
        });
      }
      setPlaybackOverride({
        source: resolved.source,
        resumeSeconds: positionSeconds,
        mediaSourceId: resolved.mediaSourceId,
        playSessionId: resolved.playSessionId,
        subtitleDeliveryMethods: resolved.subtitleDeliveryMethods,
      });
      setSelectedSubtitleIndex(track?.index ?? null);
      setSubtitlePreference(subtitlePreferenceKeyFor(track));
    } catch {
      // Best-effort: leave current playback (still showing the OLD burned-in
      // subtitle) untouched if the re-resolve fails, same policy as audio's.
    }
  };

  const buildSubtitleUrl = (track: MediaStreamTrack): string => {
    if (!session || !data) return '';
    const mediaSourceId = playbackOverride?.mediaSourceId ?? data.resolved.mediaSourceId;
    return buildSubtitleDeliveryUrl(itemId, mediaSourceId, track.index, session.jellyfinToken);
  };

  if (isLoading) {
    return (
      <main className="pf-player-screen">
        <p className="pf-player-screen__status">Cargando…</p>
      </main>
    );
  }

  if (isError || !data) {
    // Distinguish a real session/auth failure (401 on the PlaybackInfo
    // fetch itself) from any other load failure (network down, proxy
    // misconfigured, server error) - these have different fixes for the
    // user and a shared message would be misleading.
    const message = isApiError(error) && error.status === 401
      ? 'Tu sesión expiró. Volvé a iniciar sesión.'
      : 'No se pudo cargar la información de reproducción. Revisá la conexión con el servidor.';
    return (
      <main className="pf-player-screen">
        <div className="pf-player-screen__status pf-player-screen__status--error" role="alert">
          <span>{message}</span>
          <button type="button" onClick={handleBack}>
            Volver
          </button>
        </div>
      </main>
    );
  }

  if (playbackUnsupported) {
    // Genuinely rare now that transcode is wired up: only hit when the
    // browser has neither hls.js support (no MediaSource Extensions) nor
    // native HLS (Safari) for a Transcoded source.
    return (
      <main className="pf-player-screen">
        <div className="pf-player-screen__status" role="status">
          <span>Este video no se puede reproducir en este navegador.</span>
          <button type="button" onClick={handleBack}>
            Volver
          </button>
        </div>
      </main>
    );
  }

  if (playbackError) {
    // The <video>/hls.js element fired a real fatal error mid-playback
    // (decode failure, rejected stream, etc.) - surface it explicitly
    // rather than leaving a silent black screen. This is a playback-time
    // failure, distinct from the PlaybackInfo fetch-failure message above.
    return (
      <main className="pf-player-screen">
        <div className="pf-player-screen__status pf-player-screen__status--error" role="alert">
          <span>No se pudo reproducir este video. Intentá de nuevo.</span>
          <button type="button" onClick={handleBack}>
            Volver
          </button>
        </div>
      </main>
    );
  }

  const effectiveSource = playbackOverride?.source ?? data.resolved.source;
  const effectiveResumeSeconds = playbackOverride ? playbackOverride.resumeSeconds : data.resumeSeconds;
  // Subtitle dedup bug fix: whichever resolve is currently live (the base
  // one, or an audio/subtitle switch's override) is the one whose burned-in
  // map actually describes what's in the playing video right now.
  const effectiveSubtitleDeliveryMethods = playbackOverride?.subtitleDeliveryMethods ?? data.resolved.subtitleDeliveryMethods;

  return (
    <main className="pf-player-screen">
      <VideoSurface
        videoRef={videoRef}
        source={effectiveSource}
        resumeSeconds={effectiveResumeSeconds}
        title={data.title}
        onBack={handleBack}
        onPlay={heartbeat.onPlay}
        onPause={heartbeat.onPause}
        onEnded={heartbeat.onEnded}
        onError={() => setPlaybackError(true)}
        onUnsupported={() => setPlaybackUnsupported(true)}
        audioTracks={audioTracks}
        subtitleTracks={subtitleTracks}
        selectedAudioIndex={selectedAudioIndex}
        selectedSubtitleIndex={selectedSubtitleIndex}
        onAudioApplied={handleAudioApplied}
        onAudioSwitchUnavailable={handleAudioSwitchUnavailable}
        onSubtitleApplied={handleSubtitleApplied}
        selectedSecondSubtitleIndex={selectedSecondSubtitleIndex}
        onSecondSubtitleApplied={handleSecondSubtitleApplied}
        subtitleDeliveryMethods={effectiveSubtitleDeliveryMethods}
        onSubtitleSwitchUnavailable={handleSubtitleSwitchUnavailable}
        buildSubtitleUrl={buildSubtitleUrl}
        isEpisode={isEpisode}
        episodes={seriesEpisodes.data ?? []}
        currentEpisodeId={itemId}
        onSelectEpisode={handleNavigateToEpisode}
        jellyfinToken={session?.jellyfinToken ?? null}
      />
    </main>
  );
}
