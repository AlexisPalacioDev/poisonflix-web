import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlaybackHeartbeat } from '../../hooks/usePlaybackHeartbeat';
import { usePlaybackInfo } from '../../hooks/usePlaybackInfo';
import { isApiError } from '../../lib/http/errors';
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

export function PlayerScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const itemId = id ?? '';

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [playbackUnsupported, setPlaybackUnsupported] = useState(false);

  const { data, isLoading, isError, error } = usePlaybackInfo(itemId);

  const heartbeat = usePlaybackHeartbeat({
    itemId,
    playSessionId: data?.resolved.playSessionId ?? null,
    getPositionSeconds: () => videoRef.current?.currentTime ?? 0,
  });

  const handleBack = () => navigate(-1);

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

  return (
    <main className="pf-player-screen">
      <VideoSurface
        videoRef={videoRef}
        source={data.resolved.source}
        resumeSeconds={data.resumeSeconds}
        title={data.title}
        onBack={handleBack}
        onPlay={heartbeat.onPlay}
        onPause={heartbeat.onPause}
        onEnded={heartbeat.onEnded}
        onError={() => setPlaybackError(true)}
        onUnsupported={() => setPlaybackUnsupported(true)}
      />
    </main>
  );
}
