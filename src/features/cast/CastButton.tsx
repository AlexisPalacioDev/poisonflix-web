import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { castFailureReason, playOnDevice, stopDevice } from '../../api/cast';
import type { CastDevice, CastProtocol } from '../../api/schemas/cast';
import { useAuth } from '../../hooks/useAuth';
import { useCastDevices } from '../../hooks/useCastDevices';
import { buildCastUrls } from './castUrls';
import { deviceListState } from './deviceListState';
import './cast.css';

// "Enviar a la TV": the trigger in the player's top bar plus the device sheet
// it opens.
//
// Two rules shape everything below, both from the cast contract:
//
// 1. A device that cannot be used is SHOWN, disabled, with its reason. A
//    Samsung that speaks no protocol we can drive is a television the user is
//    looking at right now - hiding it answers none of the questions they are
//    about to ask, and makes the feature look broken rather than honest.
// 2. `needsPairing` is not a failure. The TV is showing a confirmation dialog;
//    the user accepts it there and taps the device again. So it gets its own
//    message and leaves the row usable, instead of being coloured like an
//    error the user cannot fix.
//
// The scan itself is on-demand (`useCastDevices(open && ...)`): it is a
// multicast sweep of the LAN that takes seconds, and it has no business
// running just because someone opened a video.
//
// This component renders inside the player's own control bar, which makes two
// things load-bearing and easy to get wrong:
//
// - The sheet is portalled into the nearest `[data-overlay-host]` (the player
//   surface). Real Fullscreen paints nothing outside `fullscreenElement`, and
//   the iOS pseudo-fullscreen surface sits at `z-index: 9999`, so a sheet left
//   on `document.body` is invisible in both - a post-mortem the track menus
//   already carry.
// - Keyboard isolation is NOT done by stopping propagation here. React's
//   synthetic `stopPropagation` also stops the native event, which would kill
//   the app's document-level D-pad navigation and strand a TV remote inside
//   this sheet. `VideoSurface` asks `hasOpenOverlay()` instead.

const PROTOCOL_LABELS: Record<CastProtocol, string> = {
  ssap: 'LG webOS',
  dial: 'DIAL',
  dlna: 'DLNA',
  cast: 'Chromecast',
};

/** Last-resort text for a device the bridge marked unusable without saying
 *  why. The contract requires a `reason`, but "unusable, no explanation" is a
 *  worse thing to render than an imperfect sentence. */
const FALLBACK_REASON = 'Este dispositivo no acepta reproducción desde PoisonFlix.';

type FeedbackTone = 'success' | 'pairing' | 'error';
interface Feedback {
  tone: FeedbackTone;
  text: string;
}

export interface CastButtonProps {
  /** Jellyfin item id of what is playing - becomes `/cast/:id` on the app URL. */
  itemId: string;
  /** Shown on the television by the adapters that can display a title. */
  title: string;
  /** The stream URL of the source currently resolved (`streamUrlOf`). */
  streamUrl: string;
}

function CastGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M3 12a8 8 0 0 1 8 8M3 16a4 4 0 0 1 4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="3.6" cy="19.4" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function CastButton({ itemId, title, streamUrl }: CastButtonProps) {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<Element | null>(null);
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  /** Devices this session has successfully started and not stopped. A list,
   *  not a single value: casting to a second television does not stop the
   *  first, so collapsing them would leave the first one playing with no way
   *  to stop it from here. */
  const [playingOn, setPlayingOn] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const reasonIdPrefix = useId();

  // Read here rather than passed down from the player: the token is a session
  // concern, and threading it through every screen that shows this button
  // would give each one its own chance to forget.
  const { session } = useAuth();
  const token = session?.jellyfinToken ?? '';

  // Resolved before anything is scanned. On a dev machine at localhost there
  // is nothing a television could open, and finding that out AFTER picking a
  // device would mean a TV that never reacts and an app that looks fine. The
  // same is true of a session with no token: `buildCastUrls` refuses, and the
  // sheet shows the reason instead of sweeping the LAN for devices it could
  // only hand a URL that 401s.
  const urls = useMemo(
    () => buildCastUrls({ origin: window.location.origin, itemId, streamUrl, token }),
    [itemId, streamUrl, token],
  );
  const urlsReady = urls.kind === 'ready';

  const { devices, isFetching, hasScanned, isError, refetch } = useCastDevices(open && urlsReady);

  const state = deviceListState({
    urlsReady,
    deviceCount: devices.length,
    isFetching,
    hasScanned,
    isError,
  });

  // Claim focus the moment the sheet appears. `OverlayShell` traps Tab inside
  // its backdrop subtree, but the trap only sees events that BUBBLE through
  // it - and the trigger that opened the sheet is a sibling, not a descendant.
  // Without this the first Tab walked straight out of the dialog into the
  // player controls behind it. Same fix, same reason, as `TrackMenuScaffold`.
  useEffect(() => {
    if (!open) return;
    const firstButton = sheetRef.current?.querySelector<HTMLButtonElement>('button');
    firstButton?.focus();
  }, [open, state]);

  const handleOpen = () => {
    // Resolved at open time from our own position in the DOM, not read during
    // render: `document.fullscreenElement` is null in the iOS pseudo-fullscreen
    // path, and this component never re-renders when the player enters real
    // fullscreen, so either would leave the sheet portalled somewhere it is
    // not painted.
    setContainer(rootRef.current?.closest('[data-overlay-host]') ?? null);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setFeedback(null);
  };

  const handleSend = async (device: CastDevice) => {
    // One request at a time. A second tap while the first is in flight would
    // race two commands at the same television, and the loser's error message
    // would land after the winner's success.
    if (urls.kind !== 'ready' || pendingDeviceId) return;
    setPendingDeviceId(device.id);
    setFeedback(null);
    try {
      const response = await playOnDevice({
        deviceId: device.id,
        appUrl: urls.urls.appUrl,
        mediaUrl: urls.urls.mediaUrl,
        title,
      });
      if (response.needsPairing) {
        // Checked before `ok`: pairing is a step, not an outcome, and it can
        // arrive with either value depending on the adapter.
        setFeedback({
          tone: 'pairing',
          text: `Aceptá el mensaje que apareció en ${device.name} y volvé a tocarla acá para enviar el video.`,
        });
      } else if (response.ok) {
        setPlayingOn((current) => (current.indexOf(device.id) === -1 ? [...current, device.id] : current));
        setFeedback({ tone: 'success', text: `Reproduciendo en ${device.name}.` });
      } else {
        // The adapter's own sentence, whenever it sent one. It knows what
        // actually happened - the app is missing from the TV's store, the
        // video reached the device but never started, the launcher answered
        // 403 - and every one of those needs a different thing done about it.
        // The generic line only stands in when the bridge said nothing.
        setFeedback({
          tone: 'error',
          text: response.reason ?? `${device.name} rechazó la reproducción. Probá de nuevo.`,
        });
      }
    } catch (error) {
      // A failure the bridge answered with a real status code (404: the device
      // left the network) still carries its sentence in the error body. The
      // fallback below is about connectivity, which is exactly the WRONG advice
      // for a device that simply moved - so the body's reason wins when there
      // is one.
      setFeedback({
        tone: 'error',
        text:
          castFailureReason(error) ??
          `No se pudo enviar a ${device.name}. Revisá que esté encendida y en la misma red.`,
      });
    } finally {
      setPendingDeviceId(null);
    }
  };

  const handleStop = async (device: CastDevice) => {
    if (pendingDeviceId) return;
    setPendingDeviceId(device.id);
    setFeedback(null);
    try {
      const response = await stopDevice(device.id);
      if (response.needsPairing) {
        // Pairing is a step here too: the LG adapter cannot close anything
        // until the television accepts the connection. Same rule as `/play` -
        // it leaves the row usable and is not coloured like a failure, because
        // accepting on the TV and tapping again works.
        setFeedback({
          tone: 'pairing',
          text: `Aceptá el mensaje que apareció en ${device.name} y volvé a tocar "Detener".`,
        });
        return;
      }
      if (!response.ok) {
        // Stopping fails as often as starting, and it answers `ok: false` over
        // HTTP 200 the same way. Ignoring that reported "Reproducción detenida"
        // over a television that was still playing, and dropped the row that
        // offers to try again.
        setFeedback({
          tone: 'error',
          text: response.reason ?? `No se pudo detener ${device.name}.`,
        });
        return;
      }
      setPlayingOn((current) => current.filter((id) => id !== device.id));
      setFeedback({ tone: 'success', text: `Reproducción detenida en ${device.name}.` });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: castFailureReason(error) ?? `No se pudo detener ${device.name}.`,
      });
    } finally {
      setPendingDeviceId(null);
    }
  };

  return (
    <div className="pf-cast" ref={rootRef}>
      <button
        type="button"
        className="pf-cast__trigger"
        onClick={handleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Enviar a la TV"
        title="Enviar a la TV"
      >
        <CastGlyph />
      </button>

      {open ? (
        <OverlayShell
          variant="dialog"
          onDismiss={close}
          className="pf-cast-menu"
          role="dialog"
          ariaModal
          ariaLabel="Enviar a la TV"
          container={container}
        >
          <div className="pf-cast-menu__sheet" ref={sheetRef}>
            <h2 className="pf-cast-menu__title">Enviar a la TV</h2>

            {state === 'unavailable' ? (
              // The one state where scanning would be pointless: even a
              // perfectly good television could not open these addresses.
              <p className="pf-cast-menu__note pf-cast-menu__note--error" role="alert">
                {urls.kind === 'unavailable' ? urls.reason : ''}
              </p>
            ) : state === 'scanning' ? (
              <p className="pf-cast-menu__note" role="status">
                Buscando dispositivos en tu red…
              </p>
            ) : state === 'error' ? (
              // Deliberately not "revisá tu red": this branch is also where a
              // response the app could not parse lands (a bridge newer than
              // this bundle), and blaming the WiFi for a version skew sends
              // the user to fix something that is not broken.
              <div className="pf-cast-menu__note pf-cast-menu__note--error" role="alert">
                <span>
                  No se pudo leer la lista de dispositivos. Puede ser la conexión con el servidor o una
                  versión desactualizada de alguna de las dos partes.
                </span>
              </div>
            ) : state === 'empty' ? (
              // Never a spinner that runs forever: a scan that found nothing
              // is an answer, and it has to look like one. Both plausible
              // causes are named, because the server answers an empty list
              // for a missing `CAST_BRIDGE_URL` too (cast contract) and the
              // browser cannot tell the two apart.
              <div className="pf-cast-menu__empty" role="status">
                <p className="pf-cast-menu__note">No encontramos ningún dispositivo en tu red.</p>
                <p className="pf-cast-menu__note">
                  Revisá que la TV esté encendida y conectada a la misma red que el servidor. Si igual no
                  aparece, puede que al servidor le falte configurar el puente de casting.
                </p>
              </div>
            ) : (
              <ul className="pf-cast-menu__list">
                {devices.map((device, index) => {
                  const meta = [device.model, PROTOCOL_LABELS[device.protocol], device.address]
                    .filter(Boolean)
                    .join(' · ');
                  const isPending = pendingDeviceId === device.id;

                  if (device.capability === 'none') {
                    // Keyed by position, not by `device.id`: `aria-describedby`
                    // is a space-separated ID list, and the device id is a
                    // bridge-supplied string this component has no control over.
                    const reasonId = `${reasonIdPrefix}-${index}`;
                    // `aria-disabled` rather than the `disabled` attribute on
                    // purpose: a disabled button is skipped by several screen
                    // readers, and this row exists precisely to be read. It
                    // stays focusable and announces its reason through
                    // `aria-describedby`. Nothing is wired to its click - that
                    // absence, not a `preventDefault`, is what makes it inert.
                    return (
                      <li key={device.id} className="pf-cast-menu__item">
                        <button
                          type="button"
                          className="pf-cast-menu__device pf-cast-menu__device--blocked"
                          aria-disabled="true"
                          aria-describedby={reasonId}
                        >
                          <span className="pf-cast-menu__device-name">{device.name}</span>
                          <span className="pf-cast-menu__device-meta">{meta}</span>
                        </button>
                        <p className="pf-cast-menu__device-reason" id={reasonId}>
                          {device.reason ?? FALLBACK_REASON}
                        </p>
                      </li>
                    );
                  }

                  const isPlaying = playingOn.indexOf(device.id) !== -1;
                  return (
                    <li key={device.id} className="pf-cast-menu__item">
                      <button
                        type="button"
                        className={`pf-cast-menu__device${isPlaying ? ' pf-cast-menu__device--active' : ''}`}
                        onClick={() => void handleSend(device)}
                        aria-busy={isPending}
                      >
                        <span className="pf-cast-menu__device-name">{device.name}</span>
                        <span className="pf-cast-menu__device-meta">{isPending ? 'Enviando…' : meta}</span>
                      </button>
                      {isPlaying ? (
                        <button
                          type="button"
                          className="pf-cast-menu__secondary"
                          onClick={() => void handleStop(device)}
                        >
                          Detener en {device.name}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* A re-scan that failed while devices are still on screen: the
                list stays (it is the truth we have), and the failure is said
                out loud here instead of replacing it. */}
            {state === 'list' && isError ? (
              <p className="pf-cast-menu__note pf-cast-menu__note--error" role="alert">
                No se pudo actualizar la lista. Estos son los dispositivos de la última búsqueda.
              </p>
            ) : null}

            {feedback ? (
              <p
                className={`pf-cast-menu__note pf-cast-menu__note--${feedback.tone}`}
                role={feedback.tone === 'error' ? 'alert' : 'status'}
              >
                {feedback.text}
              </p>
            ) : null}

            <div className="pf-cast-menu__actions">
              {urlsReady ? (
                <button
                  type="button"
                  className="pf-cast-menu__secondary"
                  onClick={() => void refetch()}
                  disabled={isFetching}
                >
                  {isFetching ? 'Buscando…' : 'Buscar de nuevo'}
                </button>
              ) : null}
              <button type="button" className="pf-cast-menu__secondary" onClick={close}>
                Cerrar
              </button>
            </div>
          </div>
        </OverlayShell>
      ) : null}
    </div>
  );
}
