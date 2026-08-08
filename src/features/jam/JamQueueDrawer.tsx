import { CoverImage } from '../music/CoverImage';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { sendJamTransport } from '../../api/jam';
import { reportFailure } from '../../lib/obs/report';
import type { JamRoomState } from './roomState';
import '../music/QueueDrawer.css';

// The room's queue, opened from the now-playing bar.
//
// A separate component from `QueueDrawer` rather than a mode inside it: they
// share a look and nothing else. The local queue is this device's list, freely
// reorderable, with an autoplay switch that decides what happens when it runs
// out. A room's queue is shared state on a server, changing it is a transport
// command anyone present can see land, and only someone with control rights
// may do it. Folding both into one component would have meant a prop for every
// one of those differences.
//
// It borrows QueueDrawer.css deliberately. Two panels that open from the same
// button, in the same place, doing the same job for two channels should not
// look like two different features.

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function JamQueueDrawer({
  room,
  onClose,
  notify,
}: {
  room: JamRoomState;
  onClose: () => void;
  /** Where a jump that did not land gets announced. A jump IS a transport
   *  command, so it reports through the bar's single notice rather than
   *  growing a second, drawer-shaped way of saying the same thing. Structural
   *  so this file need not import the bar. */
  notify?: { begin: () => { ok: () => void; failed: (cause: unknown) => void } };
}) {
  const jump = (index: number) => {
    const attempt = notify?.begin();
    void sendJamTransport(room.jamId, { type: 'jump', index }).then(
      () => attempt?.ok(),
      (cause: unknown) => {
        reportFailure('jam.queue.jump', cause, { jamId: room.jamId, index });
        attempt?.failed(cause);
      },
    );
  };

  return (
    <OverlayShell variant="dialog" onDismiss={onClose} className="pf-queue__backdrop">
      <div className="pf-queue" role="dialog" aria-modal="true" aria-label={`Cola de ${room.name}`}>
        <div className="pf-queue__header">
          <h2 className="pf-queue__heading">{room.name}</h2>
          <button
            type="button"
            className="pf-queue__close"
            onClick={onClose}
            aria-label="Cerrar cola"
          >
            <CloseIcon />
          </button>
        </div>

        {room.queue.length === 0 ? (
          <p className="pf-queue__empty">La sala no tiene nada en cola.</p>
        ) : (
          <ul className="pf-queue__list">
            {room.queue.map((track, index) => {
              const active = index === room.index;
              return (
                <li
                  key={`${track.itemId}-${index}`}
                  className={`pf-queue__row${active ? ' pf-queue__row--active' : ''}`}
                >
                  <button
                    type="button"
                    className="pf-queue__play"
                    onClick={() => jump(index)}
                    disabled={!room.canControl}
                    aria-label={`Reproducir ${track.title} en la sala`}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="pf-queue__art" aria-hidden="true">
                      <CoverImage src={track.coverUrl} />
                    </span>
                    <span className="pf-queue__info">
                      <span className="pf-queue__title">{track.title}</span>
                      <span className="pf-queue__artist">{track.artist ?? 'Desconocido'}</span>
                    </span>
                    {active && (
                      <span className="pf-queue__badge" aria-hidden="true">
                        ♪
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </OverlayShell>
  );
}
