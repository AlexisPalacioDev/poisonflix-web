import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CoverImage } from '../music/CoverImage';
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
  const jams = jamsQuery.data ?? [];
  const invitations = jams.filter((entry) => entry.myRole?.acceptedAt === null);
  const mine = jams.filter((entry) => entry.myRole?.acceptedAt !== null);

  // While it is loading there is nothing honest to show, and a skeleton for a
  // row that may turn out to be a single "create" card is more noise than it
  // is worth.
  if (jamsQuery.isLoading) return null;

  return (
    <section className="pf-music__section" aria-label="Jam">
      <h2 className="pf-music__heading">Jam</h2>
      <div className="pf-music__rail-viewport">
        <div className="pf-music__rail">
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
              <button
                key={entry.jam.id}
                type="button"
                className={`pf-music__rec pf-jam-card${pending ? ' pf-jam-card--pending' : ''}`}
                onClick={() => navigate('/jam')}
              >
                <span className="pf-music__rec-art pf-jam-card__art">
                  <CoverImage src={jamCover(entry)} loading="lazy" />
                  {entry.present.length > 0 && (
                    <span className="pf-jam-card__live" aria-hidden="true" />
                  )}
                </span>
                <span className="pf-music__rec-title">{entry.jam.name}</span>
                <span className="pf-music__rec-sub">
                  {pending ? 'Te invitaron' : whoIsThere(entry)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
