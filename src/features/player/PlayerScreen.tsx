import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getPlaybackInfo, reportStopped } from '../../api/jellyfin';
import { useAuth } from '../../hooks/useAuth';
import { usePlaybackHeartbeat } from '../../hooks/usePlaybackHeartbeat';
import { usePlaybackInfo } from '../../hooks/usePlaybackInfo';
import { createBrowserDeviceProfile } from '../../lib/domain/deviceProfile';
import { isApiError } from '../../lib/http/errors';
import { resolveInitialSubtitle, setSubtitlePreference, subtitlePreferenceKeyFor } from '../../lib/domain/playerPrefs';
import { resolvePlayback, secondsToTicks, type PlaybackSource } from '../../lib/domain/streamResolver';
import { audioTracksOf, buildSubtitleDeliveryUrl, subtitleTracksOf, useItemMediaStreams, type MediaStreamTrack } from './mediaStreamTracks';
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

  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  const [subtitleResolved, setSubtitleResolved] = useState(false);

  /** Set only once a transcode audio switch has re-resolved `PlaybackInfo`
   * with a new `AudioStreamIndex` - overrides the base `data.resolved`
   * source/resume position until the next switch (or item change). */
  const [audioOverride, setAudioOverride] = useState<{
    source: PlaybackSource;
    resumeSeconds: number;
    mediaSourceId: string;
    playSessionId: string | null;
  } | null>(null);

  // Resets every per-item guard when navigating to a different item.
  useEffect(() => {
    setSelectedAudioIndex(null);
    setSelectedSubtitleIndex(null);
    setSubtitleResolved(false);
    setAudioOverride(null);
  }, [itemId]);

  // Once MediaStreams are known, pick the default audio track (display-only
  // - the server already serves its own default track, no client action
  // needed) and resolve the initial subtitle (saved preference -> language
  // match -> AUTO rule, player spec §8).
  useEffect(() => {
    if (!mediaStreams.data) return;
    const defaultAudio = audioTracks.find((t) => t.isDefault) ?? audioTracks[0] ?? null;
    if (selectedAudioIndex == null && defaultAudio) {
      setSelectedAudioIndex(defaultAudio.index);
    }
    if (!subtitleResolved) {
      const initial = resolveInitialSubtitle(subtitleTracks, defaultAudio?.language ?? null, APP_LANGUAGE);
      setSelectedSubtitleIndex(initial?.index ?? null);
      setSubtitleResolved(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaStreams.data]);

  const heartbeat = usePlaybackHeartbeat({
    itemId,
    playSessionId: audioOverride?.playSessionId ?? data?.resolved.playSessionId ?? null,
    getPositionSeconds: () => videoRef.current?.currentTime ?? 0,
  });

  const handleBack = () => navigate(-1);

  const handleAudioApplied = (track: MediaStreamTrack) => {
    setSelectedAudioIndex(track.index);
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
    const previousSession = audioOverride?.playSessionId ?? data.resolved.playSessionId;
    try {
      const playbackInfo = await getPlaybackInfo(itemId, {
        userId: session.jellyfinUserId,
        deviceProfile: createBrowserDeviceProfile(),
        audioStreamIndex: track.index,
      });
      const resolved = resolvePlayback(itemId, playbackInfo, session.jellyfinToken);
      if (previousSession && previousSession !== resolved.playSessionId) {
        void reportStopped({
          itemId,
          playSessionId: previousSession,
          positionTicks: secondsToTicks(positionSeconds),
        });
      }
      setAudioOverride({
        source: resolved.source,
        resumeSeconds: positionSeconds,
        mediaSourceId: resolved.mediaSourceId,
        playSessionId: resolved.playSessionId,
      });
      setSelectedAudioIndex(track.index);
    } catch {
      // Best-effort: leave current playback untouched if the re-resolve fails.
    }
  };

  const handleSubtitleApplied = (track: MediaStreamTrack | null) => {
    setSelectedSubtitleIndex(track?.index ?? null);
    setSubtitlePreference(subtitlePreferenceKeyFor(track));
  };

  const buildSubtitleUrl = (track: MediaStreamTrack): string => {
    if (!session || !data) return '';
    const mediaSourceId = audioOverride?.mediaSourceId ?? data.resolved.mediaSourceId;
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

  const effectiveSource = audioOverride?.source ?? data.resolved.source;
  const effectiveResumeSeconds = audioOverride ? audioOverride.resumeSeconds : data.resumeSeconds;

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
        buildSubtitleUrl={buildSubtitleUrl}
      />
    </main>
  );
}
