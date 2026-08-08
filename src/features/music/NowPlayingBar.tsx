import { useEffect, useReducer, useRef, useState } from 'react';
import { ThumbButtons } from './ThumbButtons';
import { Link, useLocation } from 'react-router-dom';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { CoverImage } from './CoverImage';
import { useOptionalMusicPlayer, type MusicPlayerContextValue, type RepeatMode } from './musicPlayerCore';
import { QueueDrawer } from './QueueDrawer';
import { sendJamTransport, type JamTransportCommand } from '../../api/jam';
import { expectedPositionMs } from '../jam/jamPlayhead';
import { JamQueueDrawer } from '../jam/JamQueueDrawer';
import { useJamRoom, type JamRoomState } from '../jam/roomState';
import { reportFailure } from '../../lib/obs/report';
import { isApiError, isNetworkError } from '../../lib/http/errors';
import { sectionOf } from '../../lib/domain/lastSection';
import './NowPlayingBar.css';

// Persistent Spotify-style now-playing surface, fixed to the bottom of the
// viewport. Rendered inside AppLayout (so it sits above every authed screen)
// but reads player state from the provider that lives above the router, so it
// reflects playback that started on any screen.
//
// IT IS THE CONTROL FOR WHICHEVER CHANNEL IS THE OUTPUT, not for the local
// audio element. Picking a Jam in the rail makes that room the output (see
// `destination.ts`), and from that moment the bar shows what the ROOM is
// playing and its buttons send transport there. This is the whole point: the
// alternative — a bar that only ever knows the local element — is what made
// pressing play with a Jam selected look like nothing had happened. The track
// went to the room, and every pixel on screen kept showing a paused local
// player. See `roomState.ts` for how the room reaches this component.
//
// Two layouts, switched by viewport width:
//  - Desktop (≥ 900px): the full 3-column bar — art+meta | transport + seek |
//    volume + queue. Every control is inline and always visible.
//  - Mobile (< 900px): a compact bar — art+meta, the transport centred on the
//    bar's own axis, the queue, and a real seek row with times. Tapping the
//    meta opens a full-screen "Reproduciendo" player with the rest (shuffle,
//    repeat, volume, likes).
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

/** Shown on the disabled transport in a room this user may listen to but not
 *  steer (see `canControlTransport`). */
const NO_CONTROL_HINT = 'Solo quien dirige la sala puede controlar la reproducción';

// ---------------------------------------------------------------------------
// When a transport command does not land.
// ---------------------------------------------------------------------------

/**
 * Why a transport command never reached the room.
 *
 * Split by WHAT THE PERSON CAN DO about it, which is the only reason worth
 * telling two failures apart: `forbidden` means asking whoever is steering the
 * room, `offline` means waiting for the connection to come back, `failed`
 * means pressing it again. A single "algo salió mal" would collapse three
 * different next actions into one shrug.
 */
type TransportFailure = 'forbidden' | 'offline' | 'failed';

const TRANSPORT_FAILURE_MESSAGE: Record<TransportFailure, string> = {
  forbidden: 'La sala rechazó el comando: solo quien la dirige puede controlar la reproducción.',
  offline: 'Sin conexión: el comando no llegó a la sala.',
  failed: 'No se pudo enviar el comando a la sala. Intenta de nuevo.',
};

/**
 * A 403 is the server disagreeing with the snapshot the bar is drawn from —
 * control was handed to someone else and this client has not been told yet.
 * A `NetworkError` never reached the server at all. Everything else (5xx, a
 * room that no longer exists, a malformed reply) is one bucket: the advice is
 * the same.
 */
function classifyTransportFailure(cause: unknown): TransportFailure {
  if (isApiError(cause)) return cause.status === 403 ? 'forbidden' : 'failed';
  if (isNetworkError(cause)) return 'offline';
  return 'failed';
}

/** How long the notice stays up. Long enough to read a full sentence, short
 *  enough that it is gone before it becomes furniture. */
const TRANSPORT_NOTICE_MS = 6000;

/** One command's outcome. `begin()` is called as the request goes out, so the
 *  handle knows WHICH press it speaks for — see the race note in
 *  `useTransportNotice`. */
interface TransportAttempt {
  ok: () => void;
  failed: (cause: unknown) => void;
}

/** Told when a transport command lands or does not. Structural on purpose, so
 *  the room's queue drawer can report through the same notice without
 *  importing this module. */
interface TransportNotifier {
  begin: () => TransportAttempt;
}

/**
 * The one visible consequence of a transport command that failed.
 *
 * Note what this deliberately does NOT do: it never touches `isPlaying`,
 * `position` or anything else the bar draws. The bar stays a pure reflection
 * of the server's snapshot — a failed pause must not leave a paused-looking
 * button behind. All this adds is a sentence saying the press did not take.
 */
function useTransportNotice() {
  const [notice, setNotice] = useState<{ kind: TransportFailure; id: number } | null>(null);
  // `role="alert"` only re-announces when the node is (re)inserted, so two
  // identical failures in a row need distinct keys or the second one is
  // silent for a screen reader — exactly the bug this whole section fixes.
  const seq = useRef(0);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), TRANSPORT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const notifier: TransportNotifier = {
    begin: () => {
      // Every notice already on screen belongs to a press older than the one
      // going out right now.
      const olderThan = seq.current;
      return {
        ok: () =>
          // Only take down a notice this command is older than. Otherwise a
          // slow `next` that eventually succeeds would silently erase the
          // failure of the `pause` pressed after it — the person would be told
          // their command landed when it did not.
          setNotice((current) => (current && current.id > olderThan ? current : null)),
        failed: (cause: unknown) => {
          seq.current += 1;
          setNotice({ kind: classifyTransportFailure(cause), id: seq.current });
        },
      };
    },
  };

  return { notice, notifier };
}

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The channel: one shape, either output.
// ---------------------------------------------------------------------------

type LocalPlayer = MusicPlayerContextValue;

/**
 * Everything the three layouts need, resolved from whichever output owns the
 * sound right now.
 *
 * Introduced so the layouts stopped being written against the local player's
 * context. They render a channel; what a press means — a reducer dispatch or
 * an HTTP transport command — is decided once, here.
 */
interface BarChannel {
  title: string;
  artist: string | null;
  /** Only local tracks carry one; the room's queue does not. */
  artistId: string | null;
  coverUrl: string | null;
  videoId: string | null;
  isPlaying: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  /** True when transport would be refused — a room without control rights, or
   *  one whose stream is down. The buttons stay visible and go inert rather
   *  than vanishing: a control that disappears reads as a bug. */
  disabled: boolean;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  /** Volume is always this device's, in both channels. */
  volume: number;
  muted: boolean;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  /** The local player, or null when a room is the output. Shuffle, repeat and
   *  the local queue are ideas a shared room does not have. */
  local: LocalPlayer | null;
  /** The room, when a Jam is the output. */
  room: JamRoomState | null;
}

function localChannel(player: LocalPlayer, track: NonNullable<LocalPlayer['current']>): BarChannel {
  return {
    title: track.title,
    artist: track.artist,
    artistId: track.artistId ?? null,
    coverUrl: track.coverUrl,
    videoId: track.videoId ?? null,
    isPlaying: player.isPlaying,
    buffering: player.buffering,
    position: player.position,
    duration: player.duration,
    disabled: false,
    toggle: player.toggle,
    next: player.next,
    prev: player.prev,
    seek: player.seek,
    volume: player.volume,
    muted: player.muted,
    setVolume: player.setVolume,
    toggleMute: player.toggleMute,
    local: player,
    room: null,
  };
}

function jamChannel(
  room: JamRoomState,
  track: NonNullable<JamRoomState['track']>,
  position: number,
  player: LocalPlayer | null,
  notify: TransportNotifier,
): BarChannel {
  const send = (command: JamTransportCommand) => {
    const attempt = notify.begin();
    void sendJamTransport(room.jamId, command).then(
      // The room accepted it, so whatever THIS press might have been blamed
      // for stops being on screen.
      attempt.ok,
      (cause: unknown) => {
        // A transport command that vanishes looks exactly like a dead button —
        // the symptom this whole change exists to remove. The console line
        // below is for us; `attempt.failed` is the half the person pressing
        // the button can actually perceive.
        reportFailure('jam.bar.transport', cause, { jamId: room.jamId, command: command.type });
        attempt.failed(cause);
      },
    );
  };
  const duration = track.durationSeconds ?? 0;

  return {
    title: track.title,
    artist: track.artist,
    artistId: null,
    coverUrl: track.coverUrl,
    videoId: track.videoId ?? null,
    isPlaying: room.playhead.isPlaying === true,
    // The room's own buffering is not observable from here, and the local
    // element's would be about a different sound.
    buffering: false,
    position: duration > 0 ? Math.min(position, duration) : position,
    duration,
    disabled: !room.canControl,
    toggle: () => send({ type: room.playhead.isPlaying ? 'pause' : 'play' }),
    next: () => send({ type: 'next' }),
    prev: () => send({ type: 'prev' }),
    seek: (seconds) => send({ type: 'seek', positionMs: Math.round(seconds * 1000) }),
    // The Jam's <audio> element mirrors these — see the volume effect in
    // `useJamPlayback`.
    volume: player?.volume ?? 1,
    muted: player?.muted ?? false,
    setVolume: (value) => player?.setVolume(value),
    toggleMute: () => player?.toggleMute(),
    local: null,
    room,
  };
}

/**
 * The room's playhead, projected forward from the frame the server last sent.
 *
 * A room broadcasts a playhead only when something happens to it, so without
 * this the bar's clock would sit frozen at 0:12 for a whole song. `at` is on
 * the server's clock and this compares it against the device's raw one, which
 * is fine for a read-out and would not be for playback: `useJamPlayback`
 * measures a real offset because a quarter-second error is audible there,
 * while here it is a number nobody can see move. The caller clamps the result
 * to the track's length so a badly-set phone clock cannot print 40:12 over a
 * three-minute song.
 */
function useRoomPosition(room: JamRoomState | null): number {
  const playing = room?.playhead.isPlaying === true;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [playing]);
  if (!room) return 0;
  return Math.max(0, expectedPositionMs(room.playhead, Date.now()) / 1000);
}

/** The play/pause "toggle" button, shared by every layout (size configurable). */
function ToggleButton({
  isPlaying,
  onToggle,
  size = 24,
  className = 'pf-nowplaying__toggle',
  buffering = false,
  disabled = false,
}: {
  isPlaying: boolean;
  onToggle: () => void;
  size?: number;
  className?: string;
  /** True while a stall has settled past the buffering window — the only UI
   * cue that state exists at all (see musicPlayerCore's `visibleBuffering`). */
  buffering?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={buffering ? `${className} pf-nowplaying__toggle--buffering` : className}
      onClick={onToggle}
      disabled={disabled}
      title={disabled ? NO_CONTROL_HINT : undefined}
      aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
      aria-busy={buffering || undefined}
    >
      {isPlaying ? <PauseIcon size={size} /> : <PlayIcon size={size} />}
    </button>
  );
}

/** Cover art, or a music-note placeholder. Used at every size. */
function Cover({ coverUrl, className }: { coverUrl: string | null; className: string }) {
  return (
    <div className={className}>
      <CoverImage src={coverUrl} placeholderClassName="pf-nowplaying__art-placeholder" />
    </div>
  );
}

/**
 * Title plus the subtitle line, which is also where the room shows up.
 *
 * A chip rather than a banner or a separate row: "your music is coming out
 * over there" is a qualifier on what is playing, so it belongs beside the
 * artist, at the size of a qualifier. The dot goes dim when the stream drops,
 * because at that point the room state on screen is the last thing we heard
 * rather than what is happening.
 */
function Meta({ channel, compact = false }: { channel: BarChannel; compact?: boolean }) {
  // On a 390px bar the subtitle holds ONE thing. Centring the play button on
  // the bar's axis costs the side columns half the width each (that is what
  // centring means), which leaves roughly seventy pixels here — enough for a
  // room name or an artist, not both truncated to three letters. The room
  // wins when there is one: the title already says what is playing, and where
  // it is going is the thing you cannot deduce. The artist is one tap away in
  // the full player, which also shows the room name in full.
  const showArtist = channel.artist && !(compact && channel.room);

  return (
    <>
      <span className="pf-nowplaying__title">{channel.title}</span>
      <span className="pf-nowplaying__sub">
        {channel.room && (
          <span
            className={`pf-nowplaying__room${channel.room.connected ? '' : ' pf-nowplaying__room--stale'}`}
          >
            <span className="pf-nowplaying__room-dot" aria-hidden="true" />
            <span className="pf-nowplaying__sr">
              {channel.room.connected ? 'Sonando en la sala ' : 'Sala sin conexión: '}
            </span>
            {/* The name needs its own box: `text-overflow` acts on a block's
                own text, and the chip is a flex container, so a long room name
                was being hard-clipped mid-letter instead of ellipsised. */}
            <span className="pf-nowplaying__room-name">{channel.room.name}</span>
          </span>
        )}
        {showArtist && <span className="pf-nowplaying__artist">{channel.artist}</span>}
      </span>
    </>
  );
}

/** prev · play/pause · next, in that order and symmetric, so the play button
 *  lands on the exact centre of whatever box holds it. */
function Transport({
  channel,
  toggleSize,
  toggleClassName,
}: {
  channel: BarChannel;
  toggleSize?: number;
  toggleClassName?: string;
}) {
  return (
    <>
      <button
        type="button"
        className="pf-nowplaying__btn"
        onClick={channel.prev}
        disabled={channel.disabled}
        title={channel.disabled ? NO_CONTROL_HINT : undefined}
        aria-label="Anterior"
      >
        <PrevIcon />
      </button>
      <ToggleButton
        isPlaying={channel.isPlaying}
        onToggle={channel.toggle}
        size={toggleSize}
        className={toggleClassName}
        buffering={channel.buffering}
        disabled={channel.disabled}
      />
      <button
        type="button"
        className="pf-nowplaying__btn"
        onClick={channel.next}
        disabled={channel.disabled}
        title={channel.disabled ? NO_CONTROL_HINT : undefined}
        aria-label="Siguiente"
      >
        <NextIcon />
      </button>
    </>
  );
}

function SeekBar({ channel }: { channel: BarChannel }) {
  return (
    <input
      type="range"
      className="pf-nowplaying__seekbar"
      min={0}
      max={Math.max(channel.duration, 0.1)}
      step="any"
      value={Math.min(channel.position, channel.duration || channel.position)}
      onChange={(e) => channel.seek(Number(e.currentTarget.value))}
      disabled={channel.disabled || channel.duration <= 0}
      aria-label="Buscar en la pista"
    />
  );
}

// ---------------------------------------------------------------------------
// Desktop: the 3-column bar.
// ---------------------------------------------------------------------------
function DesktopBar({
  channel,
  cycleRepeat,
  queueOpen,
  onToggleQueue,
}: {
  channel: BarChannel;
  cycleRepeat: () => void;
  queueOpen: boolean;
  onToggleQueue: () => void;
}) {
  const local = channel.local;

  return (
    <div className="pf-nowplaying" role="region" aria-label="Reproduciendo ahora">
      <div className="pf-nowplaying__now">
        <Cover coverUrl={channel.coverUrl} className="pf-nowplaying__art" />
        <div className="pf-nowplaying__meta">
          <Meta channel={channel} />
        </div>
      </div>

      <div className="pf-nowplaying__center">
        <div className="pf-nowplaying__controls">
          {/* Shuffle and repeat are local-queue state. A room has one shared
              queue and one playhead; there is nothing here to toggle. */}
          {local && (
            <button
              type="button"
              className={`pf-nowplaying__btn pf-nowplaying__btn--dot${local.shuffle ? ' pf-nowplaying__btn--on' : ''}`}
              onClick={local.toggleShuffle}
              aria-label="Aleatorio"
              aria-pressed={local.shuffle}
            >
              <ShuffleIcon />
            </button>
          )}
          <Transport channel={channel} />
          {local && (
            <button
              type="button"
              className={`pf-nowplaying__btn pf-nowplaying__btn--dot${local.repeat !== 'off' ? ' pf-nowplaying__btn--on' : ''}`}
              onClick={cycleRepeat}
              aria-label={REPEAT_LABEL[local.repeat]}
              aria-pressed={local.repeat !== 'off'}
            >
              <RepeatIcon mode={local.repeat} />
            </button>
          )}
        </div>

        <div className="pf-nowplaying__seek">
          <span className="pf-nowplaying__time">{formatTime(channel.position)}</span>
          <SeekBar channel={channel} />
          <span className="pf-nowplaying__time">{formatTime(channel.duration)}</span>
        </div>
      </div>

      <div className="pf-nowplaying__extra">
        <button
          type="button"
          className="pf-nowplaying__btn"
          onClick={channel.toggleMute}
          aria-label={channel.muted ? 'Activar sonido' : 'Silenciar'}
          aria-pressed={channel.muted}
        >
          <VolumeIcon muted={channel.muted} />
        </button>
        <input
          type="range"
          className="pf-nowplaying__volume"
          min={0}
          max={1}
          step="0.01"
          value={channel.muted ? 0 : channel.volume}
          onChange={(e) => channel.setVolume(Number(e.currentTarget.value))}
          aria-label="Volumen"
        />
        {/* Thumbs sit beside the transport, where YT Music puts them. Only for
            tracks with a videoId: a library track that was never matched to one
            has nothing the worker can key a vote on. */}
        {channel.videoId && (
          <ThumbButtons
            videoId={channel.videoId}
            title={channel.title}
            artist={channel.artist}
            thumbnailUrl={channel.coverUrl}
            variant="bar"
          />
        )}
        <button
          type="button"
          className={`pf-nowplaying__btn${queueOpen ? ' pf-nowplaying__btn--on' : ''}`}
          onClick={onToggleQueue}
          aria-label={channel.room ? `Cola de ${channel.room.name}` : 'Cola'}
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

/**
 * The compact bar.
 *
 * Three grid columns, the outer two equal (`minmax(0, 1fr)`), so the middle
 * one — the transport — sits on the bar's true centre no matter how long the
 * title is. It used to be `justify-content: space-between` on a flex row,
 * which pinned the buttons to the right edge and left the play button
 * wherever the title happened to push it.
 *
 * The seek row is a second grid row rather than a squeeze into the first. It
 * costs about 20px of height and buys back the thing the old compact bar had
 * quietly dropped: knowing where you are in the song, and being able to move.
 * Everything else that used to be reachable only by opening the full player —
 * the queue — is one tap from here too.
 */
function CompactBar({
  channel,
  onExpand,
  onOpenQueue,
}: {
  channel: BarChannel;
  onExpand: () => void;
  onOpenQueue: () => void;
}) {
  return (
    <div className="pf-nowplaying pf-nowplaying--compact" role="region" aria-label="Reproduciendo ahora">
      <button
        type="button"
        className="pf-nowplaying__expand"
        onClick={onExpand}
        aria-label={`Abrir reproductor: ${channel.title}`}
      >
        <Cover coverUrl={channel.coverUrl} className="pf-nowplaying__art pf-nowplaying__art--compact" />
        <span className="pf-nowplaying__meta">
          <Meta channel={channel} compact />
        </span>
      </button>

      <div className="pf-nowplaying__compact-controls">
        <Transport
          channel={channel}
          toggleSize={26}
          toggleClassName="pf-nowplaying__toggle pf-nowplaying__toggle--compact"
        />
      </div>

      <div className="pf-nowplaying__compact-actions">
        <button
          type="button"
          className="pf-nowplaying__btn"
          onClick={onOpenQueue}
          aria-label={channel.room ? `Cola de ${channel.room.name}` : 'Cola'}
        >
          <QueueIcon />
        </button>
      </div>

      <div className="pf-nowplaying__compact-seek">
        <span className="pf-nowplaying__time">{formatTime(channel.position)}</span>
        <SeekBar channel={channel} />
        <span className="pf-nowplaying__time">{formatTime(channel.duration)}</span>
      </div>
    </div>
  );
}

function FullPlayer({
  channel,
  cycleRepeat,
  onCollapse,
  onOpenQueue,
}: {
  channel: BarChannel;
  cycleRepeat: () => void;
  onCollapse: () => void;
  onOpenQueue: () => void;
}) {
  const local = channel.local;

  const artistNode = channel.artist ? (
    channel.artistId ? (
      <Link
        to={`/musica/artist/${channel.artistId}`}
        className="pf-fullplayer__artist pf-fullplayer__artist--link"
        onClick={onCollapse}
        aria-label={`Ir al artista ${channel.artist}`}
      >
        {channel.artist}
      </Link>
    ) : (
      <span className="pf-fullplayer__artist">{channel.artist}</span>
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
        <span className="pf-fullplayer__eyebrow">
          {channel.room ? `En ${channel.room.name}` : 'Reproduciendo'}
        </span>
        {/* Spacer mirrors the chevron so the eyebrow stays centered. */}
        <span className="pf-fullplayer__chevron" aria-hidden="true" />
      </header>

      {/* The artwork, blurred, as the room's own light. Taken from the
          reference the owner asked for: the screen is coloured by whatever is
          playing rather than by a fixed palette, so every track feels like its
          own place. Heavily blurred and dimmed, so it reads as atmosphere and
          never competes with the text over it. */}
      {channel.coverUrl && (
        <div className="pf-fullplayer__washbox" aria-hidden="true">
          <div
            className="pf-fullplayer__wash"
            style={{ backgroundImage: `url(${channel.coverUrl})` }}
          />
        </div>
      )}

      {/* Artist and title above the cover, on one line, as in the reference.
          It reads as a sentence — who, then what — instead of as a stacked
          label under an image. */}
      <div className="pf-fullplayer__meta">
        <h2 className="pf-fullplayer__title">
          {channel.artist && <span className="pf-fullplayer__who">{channel.artist} — </span>}
          {channel.title}
        </h2>
      </div>

      <div className="pf-fullplayer__art">
        <CoverImage src={channel.coverUrl} placeholderClassName="pf-nowplaying__art-placeholder" />
      </div>

      {artistNode && <div className="pf-fullplayer__sub">{artistNode}</div>}

      <div className="pf-fullplayer__seek">
        <SeekBar channel={channel} />
        <div className="pf-fullplayer__times">
          <span className="pf-nowplaying__time">{formatTime(channel.position)}</span>
          <span className="pf-nowplaying__time">{formatTime(channel.duration)}</span>
        </div>
      </div>

      <div className="pf-fullplayer__transport">
        {local && (
          <button
            type="button"
            className={`pf-nowplaying__btn${local.shuffle ? ' pf-nowplaying__btn--on' : ''}`}
            onClick={local.toggleShuffle}
            aria-label="Aleatorio"
            aria-pressed={local.shuffle}
          >
            <ShuffleIcon />
          </button>
        )}
        <Transport
          channel={channel}
          toggleSize={34}
          toggleClassName="pf-nowplaying__toggle pf-fullplayer__toggle"
        />
        {local && (
          <button
            type="button"
            className={`pf-nowplaying__btn${local.repeat !== 'off' ? ' pf-nowplaying__btn--on' : ''}`}
            onClick={cycleRepeat}
            aria-label={REPEAT_LABEL[local.repeat]}
            aria-pressed={local.repeat !== 'off'}
          >
            <RepeatIcon mode={local.repeat} />
          </button>
        )}
      </div>

      <div className="pf-fullplayer__bottom">
        {/* Same "no rating possible" guard as the desktop bar: a library track
            never matched to a videoId has nothing the worker can key a vote on. */}
        {channel.videoId && (
          <ThumbButtons
            videoId={channel.videoId}
            title={channel.title}
            artist={channel.artist}
            thumbnailUrl={channel.coverUrl}
            variant="full"
          />
        )}
        <div className="pf-fullplayer__volume">
          <button
            type="button"
            className="pf-nowplaying__btn"
            onClick={channel.toggleMute}
            aria-label={channel.muted ? 'Activar sonido' : 'Silenciar'}
            aria-pressed={channel.muted}
          >
            <VolumeIcon muted={channel.muted} />
          </button>
          <input
            type="range"
            className="pf-nowplaying__volume pf-fullplayer__volume-range"
            min={0}
            max={1}
            step="0.01"
            value={channel.muted ? 0 : channel.volume}
            onChange={(e) => channel.setVolume(Number(e.currentTarget.value))}
            aria-label="Volumen"
          />
        </div>
        <button
          type="button"
          className="pf-fullplayer__queue-btn"
          onClick={onOpenQueue}
          aria-label={channel.room ? `Cola de ${channel.room.name}` : 'Cola'}
        >
          <QueueIcon />
          <span>Cola</span>
        </button>
      </div>
    </OverlayShell>
  );
}

export function NowPlayingBar() {
  const player = useOptionalMusicPlayer();
  const room = useJamRoom();
  const roomPosition = useRoomPosition(room);
  const [queueOpen, setQueueOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Tablets and up get the roomy desktop bar; phones get the compact/full-screen
  // pattern. 900px keeps the 3-column layout from ever cramping.
  const isCompact = useMediaQuery('(max-width: 899px)');
  const { notice, notifier } = useTransportNotice();
  // The now-playing bar belongs to the MUSIC HALF of the app. On the cine side
  // (PoisonFlix gold — Home, detail, /downloads, the video player…) it must not
  // show at all: the audio keeps playing in the background and the controls
  // come back the moment you return. It's rendered by AppLayout, which wraps
  // EVERY authed screen, so this route gate is the only thing keeping it off
  // cine.
  //
  // The gate is `sectionOf` — the same helper that decides which half to reopen
  // in — rather than a `/musica` prefix test, because a Jam IS the music half
  // (`lastSection.ts` has said so all along) and the prefix test was silently
  // excluding it. That left `/jam` with no transport at all after the room
  // screen dropped its own prev/play/next on the grounds that "the bar has
  // them": you could not pause the room you were standing in without navigating
  // away from it. One definition of the section, used by both.
  //
  // `playerRef` holds the latest player so the pause effect need not depend on
  // `player` (its identity changes every tick).
  const pathname = useLocation().pathname;
  const inMusicSection = sectionOf(pathname) === 'musica';
  const inCinemaVideo = pathname.startsWith('/player/');
  const playerRef = useRef(player);
  playerRef.current = player;

  // Never leave the full-screen player mounted once we're back on a wide layout.
  useEffect(() => {
    if (!isCompact) setExpanded(false);
  }, [isCompact]);

  // Watching a movie pauses the music so it can't play under the film's own
  // audio. Fires only when crossing the /player boundary, not on every tick.
  //
  // Deliberately local-only. A Jam is other people's room: stopping everyone
  // else's music because one member opened a film would be a much ruder thing
  // than the overlap this prevents, and leaving the room is already the way to
  // stop hearing it.
  useEffect(() => {
    if (inCinemaVideo && playerRef.current?.isPlaying) playerRef.current.toggle();
  }, [inCinemaVideo]);

  // The output decides what the bar is. A room wins whenever one is chosen and
  // has something loaded — with a Jam selected the local element has already
  // been silenced (`useJamPlayback`), so its leftover track is not what is
  // being heard and must not be what is shown.
  const localTrack = player && player.queue.length > 0 ? player.current : null;
  const channel: BarChannel | null = room?.track
    ? jamChannel(room, room.track, roomPosition, player, notifier)
    : player && localTrack
      ? localChannel(player, localTrack)
      : null;

  // Music-half surface: hidden everywhere on the cine side.
  if (!channel || !inMusicSection) return null;

  const local = channel.local;
  const cycleRepeat = () => {
    if (!local) return;
    const order: RepeatMode[] = ['off', 'all', 'one'];
    local.setRepeat(order[(order.indexOf(local.repeat) + 1) % order.length]);
  };

  const queue =
    queueOpen &&
    (channel.room ? (
      <JamQueueDrawer
        room={channel.room}
        onClose={() => setQueueOpen(false)}
        notify={notifier}
      />
    ) : (
      <QueueDrawer onClose={() => setQueueOpen(false)} />
    ));

  // One notice for every transport command in the room, wherever it was
  // pressed — bar, full-screen player or queue drawer. Rendered as a sibling
  // of the bar and positioned above all three (see `.pf-nowplaying__alert`),
  // so it is legible with the full player open and costs the bar no height:
  // `QueueDrawer.css` reserves 88px above the bottom edge and the bar must
  // keep fitting inside it.
  const alert = notice && (
    <div key={notice.id} className="pf-nowplaying__alert" role="alert">
      <AlertIcon />
      <span>{TRANSPORT_FAILURE_MESSAGE[notice.kind]}</span>
    </div>
  );

  if (isCompact) {
    return (
      <>
        <CompactBar
          channel={channel}
          onExpand={() => setExpanded(true)}
          onOpenQueue={() => setQueueOpen(true)}
        />
        {expanded && (
          <FullPlayer
            channel={channel}
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
        {queue}
        {alert}
      </>
    );
  }

  return (
    <>
      <DesktopBar
        channel={channel}
        cycleRepeat={cycleRepeat}
        queueOpen={queueOpen}
        onToggleQueue={() => setQueueOpen((v) => !v)}
      />
      {queue}
      {alert}
    </>
  );
}
