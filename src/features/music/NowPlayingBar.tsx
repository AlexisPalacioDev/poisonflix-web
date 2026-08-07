import { useEffect, useRef, useState } from 'react';
import { ThumbButtons } from './ThumbButtons';
import { Link, useLocation } from 'react-router-dom';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { CoverImage } from './CoverImage';
import { useOptionalMusicPlayer, type MusicTrack, type RepeatMode } from './musicPlayerCore';
import { QueueDrawer } from './QueueDrawer';
import './NowPlayingBar.css';

// Persistent Spotify-style now-playing surface, fixed to the bottom of the
// viewport. Rendered inside AppLayout (so it sits above every authed screen)
// but reads player state from the provider that lives above the router, so it
// reflects playback that started on any screen.
//
// Two layouts, switched by viewport width:
//  - Desktop (≥ 900px): the full 3-column bar — art+meta | transport + seek |
//    volume + queue. Every control is inline and always visible.
//  - Mobile (< 900px): a compact bar (cover + title/artist as an expand button,
//    plus play/pause and next, with a thin green progress line on top). Tapping
//    the meta opens a full-screen "Reproduciendo" player that holds every
//    control — seek, full transport, volume, and the queue.
//
// Every control is a native <button>/<input>/<a> so `installSpatialNavigation`
// (TV remote D-pad) can reach it without any per-control wiring.

function PlayIcon({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M6 6h2v12H6zM20 6v12l-9-6z" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M16 6h2v12h-2zM4 6l9 6-9 6z" fill="currentColor" />
    </svg>
  );
}

// Shuffle / Repeat use clean stroke geometry (Lucide-style) rather than the
// filled play/pause glyphs: crossing arrows and a rounded loop read instantly
// at 20px, where a hand-plotted filled path turns to mush.
function ShuffleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
      <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
      <path d="m18 14 4 4-4 4" />
    </svg>
  );
}

function RepeatIcon({ mode }: { mode: RepeatMode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      {/* Repeat-one: the "1" numeral, tucked inside the loop (Lucide repeat-1). */}
      {mode === 'one' && <path d="M11 10h1v4" />}
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M3 6h13v2H3zM3 11h13v2H3zM3 16h9v2H3zM16 12l5 3-5 3z" fill="currentColor" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor" />
      {muted ? (
        <path d="M16 9l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="2" fill="none" />
      ) : (
        <path
          d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12"
          stroke="currentColor"
          strokeWidth="1.8"
          fill="none"
        />
      )}
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: 'Repetir',
  all: 'Repetir todo',
  one: 'Repetir una',
};

// Everything the two layouts need from the provider, resolved once.
type PlayerControls = ReturnType<typeof useResolvedPlayer>;

function useResolvedPlayer() {
  const player = useOptionalMusicPlayer();
  if (!player || player.queue.length === 0 || !player.current) return null;
  return player;
}

/** The play/pause "toggle" button, shared by both layouts (size configurable). */
function ToggleButton({
  isPlaying,
  onToggle,
  size = 24,
  className = 'pf-nowplaying__toggle',
  buffering = false,
}: {
  isPlaying: boolean;
  onToggle: () => void;
  size?: number;
  className?: string;
  /** True while a stall has settled past the buffering window — the only UI
   * cue that state exists at all (see musicPlayerCore's `visibleBuffering`). */
  buffering?: boolean;
}) {
  return (
    <button
      type="button"
      className={buffering ? `${className} pf-nowplaying__toggle--buffering` : className}
      onClick={onToggle}
      aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
      aria-busy={buffering || undefined}
    >
      {isPlaying ? <PauseIcon size={size} /> : <PlayIcon size={size} />}
    </button>
  );
}

/** Cover art, or a music-note placeholder. Used at every size. */
function Cover({ track, className }: { track: MusicTrack; className: string }) {
  return (
    <div className={className}>
      <CoverImage src={track.coverUrl} placeholderClassName="pf-nowplaying__art-placeholder" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop: the original 3-column bar (unchanged behaviour).
// ---------------------------------------------------------------------------
function DesktopBar({
  player,
  cycleRepeat,
  queueOpen,
  onToggleQueue,
}: {
  player: NonNullable<PlayerControls>;
  cycleRepeat: () => void;
  queueOpen: boolean;
  onToggleQueue: () => void;
}) {
  const {
    current,
    isPlaying,
    buffering,
    position,
    duration,
    volume,
    muted,
    repeat,
    shuffle,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
  } = player;

  return (
    <div className="pf-nowplaying" role="region" aria-label="Reproduciendo ahora">
      <div className="pf-nowplaying__now">
        <Cover track={current} className="pf-nowplaying__art" />
        <div className="pf-nowplaying__meta">
          <span className="pf-nowplaying__title">{current.title}</span>
          {current.artist && <span className="pf-nowplaying__artist">{current.artist}</span>}
        </div>
      </div>

      <div className="pf-nowplaying__center">
        <div className="pf-nowplaying__controls">
          <button
            type="button"
            className={`pf-nowplaying__btn pf-nowplaying__btn--dot${shuffle ? ' pf-nowplaying__btn--on' : ''}`}
            onClick={toggleShuffle}
            aria-label="Aleatorio"
            aria-pressed={shuffle}
          >
            <ShuffleIcon />
          </button>
          <button type="button" className="pf-nowplaying__btn" onClick={prev} aria-label="Anterior">
            <PrevIcon />
          </button>
          <ToggleButton isPlaying={isPlaying} onToggle={toggle} buffering={buffering} />
          <button type="button" className="pf-nowplaying__btn" onClick={next} aria-label="Siguiente">
            <NextIcon />
          </button>
          <button
            type="button"
            className={`pf-nowplaying__btn pf-nowplaying__btn--dot${repeat !== 'off' ? ' pf-nowplaying__btn--on' : ''}`}
            onClick={cycleRepeat}
            aria-label={REPEAT_LABEL[repeat]}
            aria-pressed={repeat !== 'off'}
          >
            <RepeatIcon mode={repeat} />
          </button>
        </div>

        <div className="pf-nowplaying__seek">
          <span className="pf-nowplaying__time">{formatTime(position)}</span>
          <input
            type="range"
            className="pf-nowplaying__seekbar"
            min={0}
            max={Math.max(duration, 0.1)}
            step="any"
            value={Math.min(position, duration || position)}
            onChange={(e) => seek(Number(e.currentTarget.value))}
            aria-label="Buscar en la pista"
          />
          <span className="pf-nowplaying__time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="pf-nowplaying__extra">
        <button
          type="button"
          className="pf-nowplaying__btn"
          onClick={toggleMute}
          aria-label={muted ? 'Activar sonido' : 'Silenciar'}
          aria-pressed={muted}
        >
          <VolumeIcon muted={muted} />
        </button>
        <input
          type="range"
          className="pf-nowplaying__volume"
          min={0}
          max={1}
          step="0.01"
          value={muted ? 0 : volume}
          onChange={(e) => setVolume(Number(e.currentTarget.value))}
          aria-label="Volumen"
        />
        {/* Thumbs sit beside the transport, where YT Music puts them. Only for
            tracks with a videoId: a library track that was never matched to one
            has nothing the worker can key a vote on. */}
        {current.videoId && (
          <ThumbButtons
            videoId={current.videoId}
            title={current.title}
            artist={current.artist}
            thumbnailUrl={current.coverUrl}
            variant="bar"
          />
        )}
        <button
          type="button"
          className={`pf-nowplaying__btn${queueOpen ? ' pf-nowplaying__btn--on' : ''}`}
          onClick={onToggleQueue}
          aria-label="Cola"
          aria-pressed={queueOpen}
        >
          <QueueIcon />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile: compact bar (collapsed) + full-screen player (expanded).
// ---------------------------------------------------------------------------
function CompactBar({
  player,
  onExpand,
}: {
  player: NonNullable<PlayerControls>;
  onExpand: () => void;
}) {
  const { current, isPlaying, buffering, position, duration, prev, toggle, next } = player;
  const progress = duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : 0;

  return (
    <div className="pf-nowplaying pf-nowplaying--compact" role="region" aria-label="Reproduciendo ahora">
      <div className="pf-nowplaying__progressline" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      <button
        type="button"
        className="pf-nowplaying__expand"
        onClick={onExpand}
        aria-label={`Abrir reproductor: ${current.title}`}
      >
        <Cover track={current} className="pf-nowplaying__art pf-nowplaying__art--compact" />
        <span className="pf-nowplaying__meta">
          <span className="pf-nowplaying__title">{current.title}</span>
          {current.artist && <span className="pf-nowplaying__artist">{current.artist}</span>}
        </span>
      </button>

      <div className="pf-nowplaying__compact-controls">
        <button type="button" className="pf-nowplaying__btn" onClick={prev} aria-label="Anterior">
          <PrevIcon />
        </button>
        <ToggleButton
          isPlaying={isPlaying}
          onToggle={toggle}
          size={26}
          className="pf-nowplaying__toggle pf-nowplaying__toggle--compact"
          buffering={buffering}
        />
        <button type="button" className="pf-nowplaying__btn" onClick={next} aria-label="Siguiente">
          <NextIcon />
        </button>
      </div>
    </div>
  );
}

function FullPlayer({
  player,
  cycleRepeat,
  onCollapse,
  onOpenQueue,
}: {
  player: NonNullable<PlayerControls>;
  cycleRepeat: () => void;
  onCollapse: () => void;
  onOpenQueue: () => void;
}) {
  const {
    current,
    isPlaying,
    buffering,
    position,
    duration,
    volume,
    muted,
    repeat,
    shuffle,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
  } = player;

  const artistNode = current.artist ? (
    current.artistId ? (
      <Link
        to={`/musica/artist/${current.artistId}`}
        className="pf-fullplayer__artist pf-fullplayer__artist--link"
        onClick={onCollapse}
        aria-label={`Ir al artista ${current.artist}`}
      >
        {current.artist}
      </Link>
    ) : (
      <span className="pf-fullplayer__artist">{current.artist}</span>
    )
  ) : null;

  // Dismissal is owned by the shared `OverlayShell` (design D:
  // `sdd/mobile-music-overhaul`): Escape (only when topmost), focus trap +
  // return, and body scroll-lock. FullPlayer is full-bleed with no "outside"
  // concept, so it opts out of backdrop-click dismissal - only Escape and its
  // own chevron button close it.
  return (
    <OverlayShell
      variant="dialog"
      onDismiss={onCollapse}
      className="pf-fullplayer"
      role="dialog"
      ariaModal
      ariaLabel="Reproduciendo"
      dismissOnBackdropClick={false}
    >
      <header className="pf-fullplayer__header">
        <button
          type="button"
          className="pf-fullplayer__chevron"
          onClick={onCollapse}
          aria-label="Contraer reproductor"
        >
          <ChevronDownIcon />
        </button>
        <span className="pf-fullplayer__eyebrow">Reproduciendo</span>
        {/* Spacer mirrors the chevron so the eyebrow stays centered. */}
        <span className="pf-fullplayer__chevron" aria-hidden="true" />
      </header>

      <div className="pf-fullplayer__art">
        <CoverImage src={current.coverUrl} placeholderClassName="pf-nowplaying__art-placeholder" />
      </div>

      <div className="pf-fullplayer__meta">
        <h2 className="pf-fullplayer__title">{current.title}</h2>
        {artistNode}
      </div>

      <div className="pf-fullplayer__seek">
        <input
          type="range"
          className="pf-nowplaying__seekbar"
          min={0}
          max={Math.max(duration, 0.1)}
          step="any"
          value={Math.min(position, duration || position)}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          aria-label="Buscar en la pista"
        />
        <div className="pf-fullplayer__times">
          <span className="pf-nowplaying__time">{formatTime(position)}</span>
          <span className="pf-nowplaying__time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="pf-fullplayer__transport">
        <button
          type="button"
          className={`pf-nowplaying__btn${shuffle ? ' pf-nowplaying__btn--on' : ''}`}
          onClick={toggleShuffle}
          aria-label="Aleatorio"
          aria-pressed={shuffle}
        >
          <ShuffleIcon />
        </button>
        <button type="button" className="pf-nowplaying__btn" onClick={prev} aria-label="Anterior">
          <PrevIcon />
        </button>
        <ToggleButton
          isPlaying={isPlaying}
          onToggle={toggle}
          size={34}
          className="pf-nowplaying__toggle pf-fullplayer__toggle"
          buffering={buffering}
        />
        <button type="button" className="pf-nowplaying__btn" onClick={next} aria-label="Siguiente">
          <NextIcon />
        </button>
        <button
          type="button"
          className={`pf-nowplaying__btn${repeat !== 'off' ? ' pf-nowplaying__btn--on' : ''}`}
          onClick={cycleRepeat}
          aria-label={REPEAT_LABEL[repeat]}
          aria-pressed={repeat !== 'off'}
        >
          <RepeatIcon mode={repeat} />
        </button>
      </div>

      <div className="pf-fullplayer__bottom">
        {/* Same "no rating possible" guard as the desktop bar (:307): a
            library track never matched to a videoId has nothing the worker
            can key a vote on. */}
        {current.videoId && (
          <ThumbButtons
            videoId={current.videoId}
            title={current.title}
            artist={current.artist}
            thumbnailUrl={current.coverUrl}
            variant="full"
          />
        )}
        <div className="pf-fullplayer__volume">
          <button
            type="button"
            className="pf-nowplaying__btn"
            onClick={toggleMute}
            aria-label={muted ? 'Activar sonido' : 'Silenciar'}
            aria-pressed={muted}
          >
            <VolumeIcon muted={muted} />
          </button>
          <input
            type="range"
            className="pf-nowplaying__volume pf-fullplayer__volume-range"
            min={0}
            max={1}
            step="0.01"
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.currentTarget.value))}
            aria-label="Volumen"
          />
        </div>
        <button
          type="button"
          className="pf-fullplayer__queue-btn"
          onClick={onOpenQueue}
          aria-label="Cola"
        >
          <QueueIcon />
          <span>Cola</span>
        </button>
      </div>
    </OverlayShell>
  );
}

export function NowPlayingBar() {
  const player = useResolvedPlayer();
  const [queueOpen, setQueueOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Tablets and up get the roomy desktop bar; phones get the compact/full-screen
  // pattern. 900px keeps the 3-column layout from ever cramping.
  const isCompact = useMediaQuery('(max-width: 899px)');
  // The now-playing bar belongs to the Música section (PoisonFy green). On the
  // cine side (PoisonFlix gold — Home, detail, downloads, the video player…) it
  // must not show at all: the audio keeps playing in the background and the
  // controls come back the moment you return to /musica. It's rendered by
  // AppLayout, which wraps EVERY authed screen, so this route gate is the only
  // thing keeping it off cine. `playerRef` holds the latest player so the pause
  // effect need not depend on `player` (its identity changes every tick).
  const pathname = useLocation().pathname;
  const inMusica = pathname.startsWith('/musica');
  const inCinemaVideo = pathname.startsWith('/player/');
  const playerRef = useRef(player);
  playerRef.current = player;

  // Never leave the full-screen player mounted once we're back on a wide layout.
  useEffect(() => {
    if (!isCompact) setExpanded(false);
  }, [isCompact]);

  // Watching a movie pauses the music so it can't play under the film's own
  // audio. Fires only when crossing the /player boundary, not on every tick.
  useEffect(() => {
    if (inCinemaVideo && playerRef.current?.isPlaying) playerRef.current.toggle();
  }, [inCinemaVideo]);

  // Música-only surface: hidden everywhere on the cine side.
  if (!player || !inMusica) return null;

  const cycleRepeat = () => {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    player.setRepeat(order[(order.indexOf(player.repeat) + 1) % order.length]);
  };

  if (isCompact) {
    return (
      <>
        <CompactBar player={player} onExpand={() => setExpanded(true)} />
        {expanded && (
          <FullPlayer
            player={player}
            cycleRepeat={cycleRepeat}
            onCollapse={() => setExpanded(false)}
            onOpenQueue={() => {
              // Collapse the full-screen player so the queue drawer (which sits
              // below it in the stacking order) is actually visible on top of
              // the compact bar.
              setExpanded(false);
              setQueueOpen(true);
            }}
          />
        )}
        {queueOpen && <QueueDrawer onClose={() => setQueueOpen(false)} />}
      </>
    );
  }

  return (
    <>
      <DesktopBar
        player={player}
        cycleRepeat={cycleRepeat}
        queueOpen={queueOpen}
        onToggleQueue={() => setQueueOpen((v) => !v)}
      />
      {queueOpen && <QueueDrawer onClose={() => setQueueOpen(false)} />}
    </>
  );
}
