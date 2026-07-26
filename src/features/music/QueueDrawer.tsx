import { useMusicPlayer } from './MusicPlayerProvider';
import './QueueDrawer.css';

// Slide-in queue panel toggled from the NowPlayingBar. Lists the queue in
// display order (the order the user built), highlights the now-playing track,
// lets any row be jumped to, and lets any track be removed. Every row action is
// a native <button> so the TV D-pad (installSpatialNavigation) can reach it.

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function QueueDrawer({ onClose }: { onClose: () => void }) {
  const { queue, currentIndex, jumpTo, removeFromQueue } = useMusicPlayer();

  return (
    <div className="pf-queue" role="dialog" aria-label="Cola de reproducción">
      <div className="pf-queue__header">
        <h2 className="pf-queue__heading">Cola</h2>
        <button type="button" className="pf-queue__close" onClick={onClose} aria-label="Cerrar cola">
          <CloseIcon />
        </button>
      </div>

      {queue.length === 0 ? (
        <p className="pf-queue__empty">La cola está vacía.</p>
      ) : (
        <ul className="pf-queue__list">
          {queue.map((track, index) => {
            const active = index === currentIndex;
            return (
              <li
                key={`${track.itemId}-${index}`}
                className={`pf-queue__row${active ? ' pf-queue__row--active' : ''}`}
              >
                <button
                  type="button"
                  className="pf-queue__play"
                  onClick={() => jumpTo(index)}
                  aria-label={`Reproducir ${track.title}`}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="pf-queue__art" aria-hidden="true">
                    {track.coverUrl ? <img src={track.coverUrl} alt="" /> : <span>♪</span>}
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
                <button
                  type="button"
                  className="pf-queue__remove"
                  onClick={() => removeFromQueue(index)}
                  aria-label={`Quitar ${track.title} de la cola`}
                >
                  <RemoveIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
