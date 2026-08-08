import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmOverlay } from '../../components/ConfirmOverlay';
import { Header } from '../../components/Header';
import { CoverImage } from '../music/CoverImage';
import { queryKeys } from '../../hooks/queryKeys';
import {
  createJam,
  inviteToJam,
  leaveJam,
  listJamDirectory,
  listJams,
  respondToJamInvite,
  setJamMode,
  setJamRole,
  transferJamOwnership,
} from '../../api/jam';
import type { Jam, JamListEntry, JamMember, JamMode } from '../../api/schemas/jam';
import { useJamStream } from './useJamStream';
import './jam.css';

// Jam: collaborative listening (see `lib/domain/jam.ts` for the leadership
// rules this screen renders, and `useJamStream` for the live room). This
// component owns only navigation (which jam, if any, is open) and wiring
// user actions to the existing `api/jam` client — every actual rule about
// who may do what already lives in the pure domain module.
//
// SCOPE — this screen administers a room; it does not play one.
// Choosing where your music comes out is done on /musica, where each Jam is a
// card in the rail you tap to make it your output. So the queue, the song
// list and the prev/play/next transport are deliberately NOT here: the queue
// already exists in Música (that is where songs are found and added), and the
// transport belongs to the global now-playing bar, which follows whatever
// destination is selected. Owner's words: "si yo entro a configuraciones de
// jam solo deberia estar las configuraciones". What is left is identity,
// people, settings, and the way out — the four things you come here for.
//
// Reference: Spotify splits a live Jam the same way. Its participants sheet
// ("In this Jam") and its guest-settings screen contain no queue and no
// transport at all; the queue is a separate surface and playback stays in the
// player.
//
// Own user id: the session store (`lib/session/store.ts`) only ever carries
// `jellyfinUserId`, the Jellyfin GUID — useless here, since every Jam
// identity (`ownerId`, `members[].userId`, `JamTrack.addedBy`) is the
// Jellyseerr id as a string (see jam.ts schema comments). `listJams()` is the
// one call that hands this screen its own Jellyseerr id for free: each
// returned entry carries `myRole`, the caller's own membership row. So rather
// than adding a new session field or a new endpoint, `ownUserId` below is
// just read off the first jam list entry that has one.

const MODE_LABEL: Record<JamMode, string> = {
  king: 'Solo mi dispositivo suena',
  everyone: 'Todos los dispositivos suenan',
};

/** One line each, because "king" and "everyone" mean nothing until you know
 *  what changes for the people in the room. */
const MODE_HINT: Record<JamMode, string> = {
  king: 'La música sale por un solo equipo. Los demás siguen la sala sin reproducir.',
  everyone: 'Cada teléfono reproduce en sincronía, así suena en toda la casa.',
};

/** Modes in the order they are offered. Shared, so the room's settings and the
 *  create form can never drift out of sync. */
const MODES: JamMode[] = ['everyone', 'king'];

/** A room looks like the music it holds, exactly as its card does on /musica:
 *  the cover of whatever is playing, falling back to the first cover it has. */
function jamCover(jam: Jam): string | null {
  const current = jam.queue[jam.current.index];
  return current?.coverUrl ?? jam.queue.find((track) => track.coverUrl)?.coverUrl ?? null;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function JamScreen() {
  const queryClient = useQueryClient();
  const [selectedJamId, setSelectedJamId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<JamMode>('everyone');
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [pendingTransfer, setPendingTransfer] = useState<JamMember | null>(null);

  // No audio element here any more. Playback follows the DESTINATION, and the
  // destination is chosen by tapping a Jam card on /musica — see JamRow.

  const jamsQuery = useQuery({ queryKey: queryKeys.jamList(), queryFn: listJams });

  // Every entry in "my jams" carries the same `myRole.userId` (it's the same
  // caller); the first one found is as good as any.
  const ownUserId = useMemo(() => {
    const withRole = jamsQuery.data?.find((entry) => entry.myRole);
    return withRole?.myRole?.userId ?? null;
  }, [jamsQuery.data]);

  const invitations = (jamsQuery.data ?? []).filter((entry) => entry.myRole?.acceptedAt === null);
  const myJams = (jamsQuery.data ?? []).filter((entry) => entry.myRole?.acceptedAt !== null);

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: queryKeys.jamList() });

  const respondMutation = useMutation({
    mutationFn: ({ jamId, accept }: { jamId: string; accept: boolean }) =>
      respondToJamInvite(jamId, accept),
    onSuccess: invalidateList,
  });

  const createMutation = useMutation({
    mutationFn: () => createJam({ name: newName.trim(), mode: newMode }),
    onSuccess: async (jam) => {
      setCreating(false);
      setNewName('');
      await invalidateList();
      setSelectedJamId(jam.id);
    },
  });

  const leaveMutation = useMutation({
    mutationFn: (jamId: string) => leaveJam(jamId),
    onSuccess: () => {
      setSelectedJamId(null);
      invalidateList();
    },
  });

  const inviteMutation = useMutation({
    mutationFn: ({ jamId, userId, name }: { jamId: string; userId: string; name: string }) =>
      inviteToJam(jamId, [{ userId, name }]),
    onSuccess: invalidateList,
  });

  const roleMutation = useMutation({
    mutationFn: ({ jamId, userId, role }: { jamId: string; userId: string; role: 'controller' | 'listener' }) =>
      setJamRole(jamId, userId, role),
  });

  const transferMutation = useMutation({
    mutationFn: ({ jamId, userId }: { jamId: string; userId: string }) => transferJamOwnership(jamId, userId),
    onSuccess: invalidateList,
  });

  const modeMutation = useMutation({
    mutationFn: ({ jamId, mode }: { jamId: string; mode: JamMode }) => setJamMode(jamId, mode),
    onSuccess: invalidateList,
  });

  if (selectedJamId) {
    return (
      <JamRoom
        jamId={selectedJamId}
        ownUserId={ownUserId}
        onBack={() => setSelectedJamId(null)}
        directoryQuery={directoryQuery}
        onDirectoryQueryChange={setDirectoryQuery}
        onInvite={(userId, name) => inviteMutation.mutate({ jamId: selectedJamId, userId, name })}
        onSetRole={(userId, role) => roleMutation.mutate({ jamId: selectedJamId, userId, role })}
        onRequestTransfer={setPendingTransfer}
        onSetMode={(mode) => modeMutation.mutate({ jamId: selectedJamId, mode })}
        onLeave={() => leaveMutation.mutate(selectedJamId)}
        pendingTransfer={pendingTransfer}
        onConfirmTransfer={() => {
          if (pendingTransfer) transferMutation.mutate({ jamId: selectedJamId, userId: pendingTransfer.userId });
          setPendingTransfer(null);
        }}
        onCancelTransfer={() => setPendingTransfer(null)}
      />
    );
  }

  return (
    <main className="pf-jam">
      <Header />

      <div className="pf-jam__shell">
        <div className="pf-jam__header">
          <h1 className="pf-jam__title">Jam</h1>
          <button type="button" className="pf-jam__create-toggle" onClick={() => setCreating((open) => !open)}>
            {creating ? 'Cancelar' : 'Crear Jam'}
          </button>
        </div>

        {creating && (
          <form
            className="pf-jam__create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (newName.trim() && !createMutation.isPending) createMutation.mutate();
            }}
          >
            <input
              type="text"
              className="pf-jam__input"
              placeholder="Nombre de la Jam"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              aria-label="Nombre de la Jam"
            />
            {/* Same option rows the room's settings use, so the choice looks
                and reads identically wherever it is made. */}
            <ModeChoice value={newMode} onChange={setNewMode} label="Modo de la Jam" />
            <button type="submit" className="pf-jam__create-submit" disabled={!newName.trim() || createMutation.isPending}>
              Crear
            </button>
          </form>
        )}

        {jamsQuery.isLoading && <p className="pf-jam__status">Cargando tus jams…</p>}
        {jamsQuery.isError && <p className="pf-jam__status pf-jam__status--error">No se pudieron cargar tus jams.</p>}

        {invitations.length > 0 && (
          <section className="pf-jam__section" aria-label="Invitaciones pendientes">
            <h2 className="pf-jam__section-title">Invitaciones pendientes</h2>
            <ul className="pf-jam__list">
              {invitations.map((entry) => (
                <li key={entry.jam.id} className="pf-jam__invite-row">
                  <span className="pf-jam__row-art">
                    <CoverImage src={jamCover(entry.jam)} loading="lazy" />
                  </span>
                  <span className="pf-jam__row-text">
                    <span className="pf-jam__row-name">{entry.jam.name}</span>
                    <span className="pf-jam__row-meta">{MODE_LABEL[entry.jam.mode]}</span>
                  </span>
                  <span className="pf-jam__invite-actions">
                    <button
                      type="button"
                      className="pf-jam__accept"
                      onClick={() => respondMutation.mutate({ jamId: entry.jam.id, accept: true })}
                    >
                      Aceptar
                    </button>
                    <button
                      type="button"
                      className="pf-jam__reject"
                      onClick={() => respondMutation.mutate({ jamId: entry.jam.id, accept: false })}
                    >
                      Rechazar
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="pf-jam__section" aria-label="Tus jams">
          <h2 className="pf-jam__section-title">Tus jams</h2>
          {!jamsQuery.isLoading && myJams.length === 0 && (
            <p className="pf-jam__status">Todavía no estás en ninguna Jam.</p>
          )}
          <ul className="pf-jam__list">
            {myJams.map((entry: JamListEntry) => (
              <li key={entry.jam.id}>
                <button
                  type="button"
                  className="pf-jam__jam-row"
                  onClick={() => setSelectedJamId(entry.jam.id)}
                >
                  <span className="pf-jam__row-art">
                    <CoverImage src={jamCover(entry.jam)} loading="lazy" />
                    {entry.present.length > 0 && <span className="pf-jam__row-live" aria-hidden="true" />}
                  </span>
                  <span className="pf-jam__row-text">
                    <span className="pf-jam__row-name">{entry.jam.name}</span>
                    <span className="pf-jam__row-meta">
                      {entry.present.length > 0
                        ? `${plural(entry.present.length, 'escuchando', 'escuchando')} · ${MODE_LABEL[entry.jam.mode]}`
                        : MODE_LABEL[entry.jam.mode]}
                    </span>
                  </span>
                  <span className="pf-jam__row-go">Configurar</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

/** The one control for "how does this room sound". Two options, both visible,
 *  both explained.
 *
 *  Explicitly NOT a `<select>`: the OS paints and positions native selects
 *  itself, which on this dark theme means white-on-white options rendered
 *  half off the edge of a phone. Nor a custom dropdown — with exactly two
 *  mutually exclusive choices, hiding one behind a tap buys nothing and costs
 *  the explanation of what you are choosing between. Spotify's own guest
 *  settings are laid out the same way: labelled rows you can read at a glance,
 *  never a picker.
 *
 *  Each option is its own tabbable `<button role="radio">` rather than an APG
 *  roving-tabindex group. That is deliberate: this app also runs on webOS TVs
 *  driven by a D-pad, where every control being individually reachable is the
 *  house rule (see the header comment in music.css). Both options stay
 *  operable by Tab and by Enter/Space either way. */
function ModeChoice({
  value,
  onChange,
  label,
}: {
  value: JamMode;
  onChange: (mode: JamMode) => void;
  label: string;
}) {
  return (
    <div className="pf-jam__choices" role="radiogroup" aria-label={label}>
      {MODES.map((mode) => {
        const selected = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`pf-jam__choice${selected ? ' pf-jam__choice--on' : ''}`}
            onClick={() => onChange(mode)}
          >
            <span className="pf-jam__choice-mark" aria-hidden="true" />
            <span className="pf-jam__choice-text">
              <span className="pf-jam__choice-title">{MODE_LABEL[mode]}</span>
              <span className="pf-jam__choice-hint">{MODE_HINT[mode]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface JamRoomProps {
  jamId: string;
  ownUserId: string | null;
  onBack: () => void;
  directoryQuery: string;
  onDirectoryQueryChange: (value: string) => void;
  onInvite: (userId: string, name: string) => void;
  onSetRole: (userId: string, role: 'controller' | 'listener') => void;
  onRequestTransfer: (member: JamMember) => void;
  onSetMode: (mode: JamMode) => void;
  onLeave: () => void;
  pendingTransfer: JamMember | null;
  onConfirmTransfer: () => void;
  onCancelTransfer: () => void;
}

/** Long directory lists are a scroll, not a chooser. Past this many the search
 *  field is the way through. */
const DIRECTORY_LIMIT = 8;

function JamRoom({
  jamId,
  ownUserId,
  onBack,
  directoryQuery,
  onDirectoryQueryChange,
  onInvite,
  onSetRole,
  onRequestTransfer,
  onSetMode,
  onLeave,
  pendingTransfer,
  onConfirmTransfer,
  onCancelTransfer,
}: JamRoomProps) {
  const navigate = useNavigate();
  const { snapshot, connected, denied } = useJamStream(jamId);

  const isOwner = ownUserId != null && snapshot?.jam.ownerId === ownUserId;

  const directoryEnabled = isOwner;
  const directoryQ = useQuery({
    queryKey: queryKeys.jamDirectory(),
    queryFn: listJamDirectory,
    enabled: directoryEnabled,
  });
  // Anyone already in the room — invitation accepted or still pending — drops
  // out of the suggestions. The BFF treats a repeat invite as a no-op, so the
  // only thing offering it again achieves is a button that looks broken.
  const alreadyInvited = new Set((snapshot?.jam.members ?? []).map((member) => member.userId));
  const matches = (directoryQ.data ?? [])
    .filter((user) => !alreadyInvited.has(user.userId))
    .filter((user) => user.name.toLowerCase().includes(directoryQuery.trim().toLowerCase()));
  const filteredDirectory = matches.slice(0, DIRECTORY_LIMIT);

  if (!snapshot) {
    return (
      <main className="pf-jam">
        <Header />
        <div className="pf-jam__shell">
          <button type="button" className="pf-jam__back" onClick={onBack}>
            ← Tus jams
          </button>
          {/* Being refused and being offline look identical to EventSource, so
              the hook tells them apart by whether the stream ever opened. Saying
              "conectando…" for ever to someone who was removed from the room is
              the one outcome worth avoiding. */}
          <p className="pf-jam__status">
            {denied
              ? 'Ya no tenés acceso a esta Jam. Puede que te hayan sacado de la sala.'
              : 'Conectando con la Jam…'}
          </p>
        </div>
      </main>
    );
  }

  const { jam, present, leaderId } = snapshot;
  const presentSet = new Set(present);
  const cover = jamCover(jam);
  const accepted = jam.members.filter((member) => member.acceptedAt !== null);
  const listening = jam.members.filter((member) => presentSet.has(member.userId)).length;

  // Whoever runs the room first, then whoever is actually in it, then the rest.
  // The order answers "who is here" before you have read a single word — the
  // same reason Spotify's participant sheet puts the host at the top.
  const people = [...jam.members].sort((a, b) => {
    const rank = (member: JamMember) =>
      (member.userId === leaderId ? 0 : 4) +
      (presentSet.has(member.userId) ? 0 : 2) +
      (member.acceptedAt === null ? 1 : 0);
    return rank(a) - rank(b);
  });

  return (
    <main className="pf-jam">
      <Header />

      <div className="pf-jam__shell">
        <button type="button" className="pf-jam__back" onClick={onBack}>
          ← Tus jams
        </button>

        {!connected && (
          <p className="pf-jam__status pf-jam__status--error" role="alert">
            Sala desconectada. Reconectando…
          </p>
        )}

        {/* Identity, the way an album page states which album you are on: the
            room's artwork, its name, and what is true about it right now. Text
            on a black page was the whole reason this screen did not look like
            the Música it belongs to. */}
        <header className="pf-jam__hero">
          <span
            className="pf-jam__hero-glow"
            style={cover ? { backgroundImage: `url("${cover}")` } : undefined}
            aria-hidden="true"
          />
          <span className="pf-jam__hero-art">
            <CoverImage src={cover} />
          </span>
          <div className="pf-jam__hero-text">
            <span className="pf-jam__hero-kicker">Sala de Jam</span>
            <h1 className="pf-jam__hero-name">{jam.name}</h1>
            {/* One string, not four JSX expressions: each expression is its own
                text node, and in a flex row every text node becomes a separate
                item that breaks on its own — which put the live dot alone on
                the first line of a phone. Plain inline text wraps properly. */}
            <p className="pf-jam__hero-meta">
              {listening > 0 && <span className="pf-jam__hero-live" aria-hidden="true" />}
              {[
                listening > 0 ? `${listening} escuchando` : null,
                plural(accepted.length, 'integrante', 'integrantes'),
                plural(jam.queue.length, 'canción en la cola', 'canciones en la cola'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {/* The queue is not on this screen and must not become a dead end.
                Adding music happens in Música: pick this room as the output,
                press play on anything. */}
            <button type="button" className="pf-jam__cta" onClick={() => navigate('/musica')}>
              Poner música
            </button>
            <p className="pf-jam__hero-hint">
              Elegí «{jam.name}» en Música y dale play a lo que quieras.
            </p>
          </div>
        </header>

        <section className="pf-jam__section" aria-label="Integrantes">
          <h2 className="pf-jam__section-title">Integrantes</h2>
          {/* A list with faces, not a table. A ring means listening right now,
              dimmed means invited and not here yet.
              The owner's two actions stay ON the row as chips. A ⋮ menu earns
              its keep when a row has many actions and the list is long — a song
              row with five of them, in a library of hundreds. Here it is two
              actions on a list of two or three people: hiding them behind a tap
              buys no density and costs the owner the explanation of where the
              room's controls went. Same reasoning that removed the native
              select from "Cómo suena" further down. */}
          <ul className="pf-jam__people">
            {people.map((member) => {
              const pending = member.acceptedAt === null;
              const here = presentSet.has(member.userId);
              const isLeader = leaderId === member.userId;
              const isSelf = member.userId === ownUserId;
              const state = pending
                ? 'Invitado, todavía no respondió'
                : here
                  ? isLeader
                    ? 'Manda la sala'
                    : member.role === 'controller'
                      ? 'Escuchando · puede controlar'
                      : 'Escuchando'
                  : 'Fuera de la sala';
              return (
                <li
                  key={member.userId}
                  className={`pf-jam__person${here ? ' pf-jam__person--here' : ''}`}
                >
                  <span
                    className={
                      'pf-jam__avatar' +
                      (here ? ' pf-jam__avatar--here' : '') +
                      (pending ? ' pf-jam__avatar--pending' : '')
                    }
                    aria-hidden="true"
                  >
                    {initials(member.name)}
                    {isLeader && <span className="pf-jam__crown" title="Manda la sala" />}
                  </span>
                  <span className="pf-jam__person-text">
                    <span className="pf-jam__person-name">
                      {member.name}
                      {isSelf && <span className="pf-jam__person-you">vos</span>}
                    </span>
                    <span className="pf-jam__person-state">{state}</span>
                  </span>
                  {isOwner && !pending && !isSelf && (
                    <span className="pf-jam__person-actions">
                      <button
                        type="button"
                        className="pf-jam__person-chip"
                        onClick={() =>
                          onSetRole(
                            member.userId,
                            member.role === 'controller' ? 'listener' : 'controller',
                          )
                        }
                      >
                        {member.role === 'controller' ? 'Quitar control' : 'Dar control'}
                      </button>
                      {/* Gold, like the crown on the avatar: this chip hands
                          over that crown, and it cannot be undone. */}
                      <button
                        type="button"
                        className="pf-jam__person-chip pf-jam__person-chip--crown"
                        onClick={() => onRequestTransfer(member)}
                      >
                        Pasarle la sala
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {isOwner && (
          <section className="pf-jam__section" aria-label="Cómo suena">
            <h2 className="pf-jam__section-title">Cómo suena</h2>
            <ModeChoice value={jam.mode} onChange={onSetMode} label="Cómo suena la sala" />
          </section>
        )}

        {isOwner && (
          <section className="pf-jam__section" aria-label="Invitar">
            <h2 className="pf-jam__section-title">Invitar</h2>
            <input
              type="text"
              className="pf-jam__input"
              placeholder="Buscar a alguien por nombre"
              value={directoryQuery}
              onChange={(event) => onDirectoryQueryChange(event.target.value)}
              aria-label="Buscar usuarios para invitar"
            />
            {filteredDirectory.length === 0 ? (
              <p className="pf-jam__status">
                {directoryQuery.trim()
                  ? 'Nadie coincide con esa búsqueda.'
                  : 'Ya está todo el mundo en la sala.'}
              </p>
            ) : (
              <ul className="pf-jam__directory">
                {filteredDirectory.map((user) => (
                  <li key={user.userId} className="pf-jam__directory-row">
                    <span className="pf-jam__avatar pf-jam__avatar--sm" aria-hidden="true">
                      {initials(user.name)}
                    </span>
                    <span className="pf-jam__directory-name">{user.name}</span>
                    <button
                      type="button"
                      className="pf-jam__invite-btn"
                      onClick={() => onInvite(user.userId, user.name)}
                    >
                      Invitar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {matches.length > filteredDirectory.length && (
              <p className="pf-jam__status">
                Y {matches.length - filteredDirectory.length} más. Buscá por nombre para acortar la
                lista.
              </p>
            )}
          </section>
        )}

        <section className="pf-jam__danger" aria-label="Dejar la Jam">
          {isOwner ? (
            <p className="pf-jam__danger-note">
              Esta sala es tuya. Para dejarla, tocá «Pasarle la sala» en la fila de esa persona, en
              Integrantes.
            </p>
          ) : (
            <button type="button" className="pf-jam__leave" onClick={onLeave}>
              Salir de la Jam
            </button>
          )}
        </section>
      </div>

      <ConfirmOverlay
        open={pendingTransfer != null}
        title="Transferir liderazgo"
        message={
          pendingTransfer
            ? `¿Transferirle la Jam a ${pendingTransfer.name}? No podés deshacer esto.`
            : ''
        }
        confirmLabel="Sí, transferir"
        dismissLabel="No, cancelar"
        danger
        onConfirm={onConfirmTransfer}
        onDismiss={onCancelTransfer}
      />
    </main>
  );
}
