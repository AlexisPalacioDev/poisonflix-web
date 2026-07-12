import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlaybackHeartbeat } from '../../hooks/usePlaybackHeartbeat';
import { usePlaybackInfo } from '../../hooks/usePlaybackInfo';
import { VideoSurface } from './VideoSurface';
import './player.css';

// Player screen (design.md §7 `/player/:id`, player spec, tasks.md 7.5),
// ported from `PlayerScreen.kt` + `PlaybackController.kt`. `:id` is the
// Jellyfin item id (design.md §7) - Detail's "Reproducir" action already
// resolves the InLibrary item's real Jellyfin id before navigating here, so
// no id-shape translation happens in this screen.
//
// DirectPlay-only for the MVP (player spec's Deferred section): a
// TranscodingUrl-bearing PlaybackInfo response renders an explicit "not
// supported in this version" message and never mounts `<VideoSurface>` at
// all - this is the hls.js seam, not an implementation of it.

export function PlayerScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const itemId = id ?? '';

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);

  const { data, isLoading, isError } = usePlaybackInfo(itemId);

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
    return (
      <main className="pf-player-screen">
        <div className="pf-player-screen__status pf-player-screen__status--error" role="alert">
          <span>No se pudo iniciar la reproducción.</span>
          <button type="button" onClick={handleBack}>
            Volver
          </button>
        </div>
      </main>
    );
  }

  if (data.resolved.source.kind === 'Transcoded') {
    // Player spec's Requirement 1, "TranscodingUrl present" scenario: an
    // explicit unsupported state, no playback attempted at all (hls.js is
    // deferred - see file header and streamResolver.ts).
    return (
      <main className="pf-player-screen">
        <div className="pf-player-screen__status" role="status">
          <span>Este título requiere transcodificación y no es compatible en esta versión.</span>
          <button type="button" onClick={handleBack}>
            Volver
          </button>
        </div>
      </main>
    );
  }

  if (playbackError) {
    // Player spec's Requirement 2, "Authentication rejected" scenario: the
    // <video> element fired a real error event (e.g. the `api_key` stream
    // was rejected with a 401) - surface it explicitly rather than leaving a
    // silent black screen.
    return (
      <main className="pf-player-screen">
        <div className="pf-player-screen__status pf-player-screen__status--error" role="alert">
          <span>No se pudo autenticar o cargar la reproducción.</span>
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
        src={data.resolved.source.url}
        resumeSeconds={data.resumeSeconds}
        title={data.title}
        onBack={handleBack}
        onPlay={heartbeat.onPlay}
        onPause={heartbeat.onPause}
        onEnded={heartbeat.onEnded}
        onError={() => setPlaybackError(true)}
      />
    </main>
  );
}
