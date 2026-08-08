import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CoverImage } from '../music/CoverImage';
import { chooseJamDestination } from './JamPlaybackHost';
import { useJamDestination } from './destination';
import { queryKeys } from '../../hooks/queryKeys';
import { listJams } from '../../api/jam';
import type { JamListEntry } from '../../api/schemas/jam';

// The Jam rail on /musica.
//
// Jam used to be reachable only from the header menu, which on a phone means
// behind the hamburger, seventh in a list with Buscar, +18, Música, Descargas,
// Admin and Cerrar sesión. The owner could not find his own feature. Listening
// together belongs where the listening is.
//
// Deliberately built from the SAME classes the recommendation rails use —
// `pf-music__section`, `pf-music__rail`, `pf-music__rec` — rather than a
// lookalike of its own. A second card style that is almost the first one is
// how a screen stops feeling like one app.

/** A room's artwork: the cover of whatever it is playing, so a Jam looks like
 *  the music it holds rather than an abstraction. */
function jamCover(entry: JamListEntry): string | null {
  const current = entry.jam.queue[entry.jam.current.index];
  return current?.coverUrl ?? entry.jam.queue.find((track) => track.coverUrl)?.coverUrl ?? null;
}

function whoIsThere(entry: JamListEntry): string {
  const listening = entry.present.length;
  if (listening > 0) return listening === 1 ? '1 escuchando' : `${listening} escuchando`;
  const members = entry.jam.members.filter((member) => member.acceptedAt !== null).length;
  return members === 1 ? '1 integrante' : `${members} integrantes`;
}

export function JamRow() {
  const navigate = useNavigate();
  const jamsQuery = useQuery({ queryKey: queryKeys.jamList(), queryFn: listJams });
  const destination = useJamDestination();
  const jams = jamsQuery.data ?? [];
  const invitations = jams.filter((entry) => entry.myRole?.acceptedAt === null);
  const mine = jams.filter((entry) => entry.myRole?.acceptedAt !== null);

  // While it is loading there is nothing honest to show, and a skeleton for a
  // row that may turn out to be a single "create" card is more noise than it
  // is worth.
  if (jamsQuery.isLoading) return null;

  return (
    <section className="pf-music__section pf-music__section--rail" aria-label="Jam">
      <h2 className="pf-music__heading">Jam</h2>
      <div className="pf-music__rail-viewport">
        <div className="pf-music__rail">
          {/* Personal mode is a card like the rest, because that is what it is:
              one more possible output. It was missing entirely — once you had
              sent your music to a room there was no obvious way back to your
              own phone. */}
          <button
            type="button"
            className={`pf-music__rec pf-jam-card${!destination ? ' pf-jam-card--on' : ''}`}
            aria-pressed={!destination}
            onClick={() => chooseJamDestination(null)}
          >
            <span className="pf-music__rec-art pf-jam-card__art pf-jam-card__art--solo">
              <span aria-hidden="true">📱</span>
            </span>
            <span className="pf-music__rec-title">Solo yo</span>
            <span className="pf-music__rec-sub">
              {destination ? 'Volver a este dispositivo' : 'Sonando acá'}
            </span>
          </button>

          <button
            type="button"
            className="pf-music__rec pf-jam-card pf-jam-card--new"
            onClick={() => navigate('/jam')}
          >
            <span className="pf-music__rec-art pf-jam-card__art pf-jam-card__art--new">
              <span aria-hidden="true">+</span>
            </span>
            <span className="pf-music__rec-title">Crear una Jam</span>
            <span className="pf-music__rec-sub">Escuchar con alguien más</span>
          </button>

          {/* Invitations first: they are the only thing here that is waiting on
              a decision, and burying them under rooms he is already in is how
              one goes unanswered for a week. */}
          {[...invitations, ...mine].map((entry) => {
            const pending = entry.myRole?.acceptedAt === null;
            return (
              <div
                key={entry.jam.id}
                className={`pf-music__rec pf-jam-card${pending ? ' pf-jam-card--pending' : ''}${
                  destination === entry.jam.id ? ' pf-jam-card--on' : ''
                }`}
              >
                {/* Tapping the card IS choosing where your music goes — the
                    card already shows the room, so a separate dropdown in the
                    header was the same job with less information. The ⋮ opens
                    the room itself, to manage who is in it. */}
                <button
                  type="button"
                  className="pf-jam-card__pick"
                  aria-pressed={destination === entry.jam.id}
                  aria-label={`Sonar en ${entry.jam.name}`}
                  onClick={() =>
                    pending ? navigate('/jam') : chooseJamDestination(entry.jam.id)
                  }
                >
                <span className="pf-music__rec-art pf-jam-card__art">
                  <CoverImage src={jamCover(entry)} loading="lazy" />
                  {entry.present.length > 0 && (
                    <span className="pf-jam-card__live" aria-hidden="true" />
                  )}
                </span>
                  <span className="pf-music__rec-title">{entry.jam.name}</span>
                  <span className="pf-music__rec-sub">
                    {pending
                      ? 'Te invitaron'
                      : destination === entry.jam.id
                        ? 'Sonando acá'
                        : whoIsThere(entry)}
                  </span>
                </button>
                <button
                  type="button"
                  className="pf-jam-card__manage"
                  aria-label={`Administrar ${entry.jam.name}`}
                  onClick={() => navigate('/jam')}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.8" fill="currentColor" />
                    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                    <circle cx="12" cy="19" r="1.8" fill="currentColor" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
