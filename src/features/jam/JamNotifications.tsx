import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import { queryKeys } from '../../hooks/queryKeys';
import { listJams, respondToJamInvite } from '../../api/jam';
import { useAuth } from '../../hooks/useAuth';
import './jam.css';

// Invitations have to find you.
//
// Jam invites arrive by user search, not by a link someone sends you in a
// chat, which means the app itself is the only thing that can tell you one is
// waiting. Until this existed an invitation sat silently in /jam and was seen
// only if you happened to wander in — the owner would invite someone and that
// person would never know.
//
// Deliberately not a separate notifications service. The pending invitations
// are already in `listJams()`, as membership rows with no `acceptedAt`, so the
// bell reads the same source the Jam screen does. A second store to keep in
// step with the first is how a count starts lying.

/** How often to look while the app is open. Slow enough to be free, quick
 *  enough that an invitation lands while the two people are still together
 *  deciding to listen to something. */
const POLL_MS = 30_000;

function BellGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M12 3a5 5 0 0 0-5 5v3.5L5.5 15h13L17 11.5V8a5 5 0 0 0-5-5zM10 18a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function JamNotifications() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);

  const jamsQuery = useQuery({
    queryKey: queryKeys.jamList(),
    queryFn: listJams,
    enabled: Boolean(session),
    refetchInterval: POLL_MS,
  });

  const invitations = (jamsQuery.data ?? []).filter((entry) => entry.myRole?.acceptedAt === null);

  const respond = useMutation({
    mutationFn: ({ jamId, accept }: { jamId: string; accept: boolean }) =>
      respondToJamInvite(jamId, accept),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jamList() });
      // Accepting is a decision to go listen, so take them there rather than
      // leaving them on whatever screen they happened to be on.
      if (variables.accept) {
        setOpen(false);
        navigate('/jam');
      }
    },
  });

  if (!session) return null;

  // No bell at all when there is nothing waiting: a permanently-present icon
  // that is almost always empty trains you to ignore it, which is the one
  // thing a notification must not do.
  if (invitations.length === 0 && !open) return null;

  return (
    <div className="pf-jam-bell">
      <button
        ref={bellRef}
        type="button"
        className="pf-jam-bell__btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          invitations.length === 1
            ? '1 invitación a una Jam'
            : `${invitations.length} invitaciones a Jams`
        }
        onClick={() => setOpen((was) => !was)}
      >
        <BellGlyph />
        {invitations.length > 0 && (
          <span className="pf-jam-bell__count" aria-hidden="true">
            {invitations.length}
          </span>
        )}
      </button>

      {open && (
        <OverlayShell
          variant="menu"
          onDismiss={() => setOpen(false)}
          ariaLabel="Cerrar invitaciones (fondo)"
          anchorRef={bellRef}
        >
          <div className="pf-jam-bell__panel" role="dialog" aria-label="Invitaciones a Jams">
            {invitations.length === 0 ? (
              <p className="pf-jam-bell__empty">No tenés invitaciones.</p>
            ) : (
              <ul className="pf-jam-bell__list">
                {invitations.map((entry) => {
                  const host = entry.jam.members.find(
                    (member) => member.userId === entry.jam.ownerId,
                  );
                  return (
                    <li key={entry.jam.id} className="pf-jam-bell__item">
                      <span className="pf-jam-bell__who">
                        <strong>{host?.name ?? 'Alguien'}</strong> te invitó a
                      </span>
                      <span className="pf-jam-bell__jam">{entry.jam.name}</span>
                      <span className="pf-jam-bell__actions">
                        <button
                          type="button"
                          className="pf-jam-bell__accept"
                          disabled={respond.isPending}
                          onClick={() => respond.mutate({ jamId: entry.jam.id, accept: true })}
                        >
                          Entrar
                        </button>
                        <button
                          type="button"
                          className="pf-jam-bell__decline"
                          disabled={respond.isPending}
                          onClick={() => respond.mutate({ jamId: entry.jam.id, accept: false })}
                        >
                          Ahora no
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </OverlayShell>
      )}
    </div>
  );
}
