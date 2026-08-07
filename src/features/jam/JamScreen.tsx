import { useMemo, useRef, useState } from 'react';
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
  sendJamTransport,
  setJamMode,
  setJamRole,
  transferJamOwnership,
} from '../../api/jam';
import type { JamListEntry, JamMember, JamMode } from '../../api/schemas/jam';
import { canControlTransport } from '../../lib/domain/jam';
import { useJamStream } from './useJamStream';
import { useJamPlayback, unlockAudioElement } from './useJamPlayback';
import './jam.css';

// Jam: collaborative listening (see `lib/domain/jam.ts` for the leadership
// rules this screen renders, and `useJamStream` for the live room). This
// component owns only navigation (which jam, if any, is open) and wiring
// user actions to the existing `api/jam` client — every actual rule about
// who may do what already lives in the pure domain module.
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

function memberName(members: JamMember[], userId: string | null): string {
  if (!userId) return '—';
  return members.find((member) => member.userId === userId)?.name ?? userId;
}

export function JamScreen() {
  const queryClient = useQueryClient();
  const [selectedJamId, setSelectedJamId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<JamMode>('everyone');
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [pendingTransfer, setPendingTransfer] = useState<JamMember | null>(null);

  // The Jam's own audio element lives HERE, not in the room, because the
  // gesture that unlocks it for iOS is the click that opens a jam — and at
  // that instant the room has not rendered yet. Entering the Jam is the button
  // to start listening, so entering is where the element earns the right to
  // play without another touch.
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
  });

  const transportMutation = useMutation({
    mutationFn: ({ jamId, command }: { jamId: string; command: Parameters<typeof sendJamTransport>[1] }) =>
      sendJamTransport(jamId, command),
  });

  // Rendered above the branch so the element survives the switch from list to
  // room. Unmounting it would throw away the very gesture that unlocked it.
  const audioElement = <audio ref={audioRef} hidden preload="none" />;

  if (selectedJamId) {
    return (
      <>
      {audioElement}
      <JamRoom
        jamId={selectedJamId}
        ownUserId={ownUserId}
        audioRef={audioRef}
        onBack={() => setSelectedJamId(null)}
        directoryQuery={directoryQuery}
        onDirectoryQueryChange={setDirectoryQuery}
        onInvite={(userId, name) => inviteMutation.mutate({ jamId: selectedJamId, userId, name })}
        onSetRole={(userId, role) => roleMutation.mutate({ jamId: selectedJamId, userId, role })}
        onRequestTransfer={setPendingTransfer}
        onSetMode={(mode) => modeMutation.mutate({ jamId: selectedJamId, mode })}
        onLeave={() => leaveMutation.mutate(selectedJamId)}
        onTransport={(command) => transportMutation.mutate({ jamId: selectedJamId, command })}
        pendingTransfer={pendingTransfer}
        onConfirmTransfer={() => {
          if (pendingTransfer) transferMutation.mutate({ jamId: selectedJamId, userId: pendingTransfer.userId });
          setPendingTransfer(null);
        }}
        onCancelTransfer={() => setPendingTransfer(null)}
      />
      </>
    );
  }

  return (
    <main className="pf-jam">
      {audioElement}
      <Header />

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
          <div className="pf-jam__mode-radios" role="radiogroup" aria-label="Modo de la Jam">
            {(Object.keys(MODE_LABEL) as JamMode[]).map((mode) => (
              <label key={mode} className="pf-jam__mode-radio">
                <input
                  type="radio"
                  name="jam-mode"
                  checked={newMode === mode}
                  onChange={() => setNewMode(mode)}
                />
                {MODE_LABEL[mode]}
              </label>
            ))}
          </div>
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
                <span className="pf-jam__invite-name">{entry.jam.name}</span>
                <span className="pf-jam__invite-mode">{MODE_LABEL[entry.jam.mode]}</span>
                <div className="pf-jam__invite-actions">
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
                </div>
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
              <button type="button" className="pf-jam__jam-row" onClick={() => {
                  void unlockAudioElement(audioRef.current);
                  setSelectedJamId(entry.jam.id);
                }}>
                <span className="pf-jam__jam-name">{entry.jam.name}</span>
                <span className="pf-jam__jam-mode">{MODE_LABEL[entry.jam.mode]}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

interface JamRoomProps {
  jamId: string;
  ownUserId: string | null;
  /** Owned by JamScreen so it outlives the switch into this room, and so the
   *  click that opened the room could unlock it for iOS. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onBack: () => void;
  directoryQuery: string;
  onDirectoryQueryChange: (value: string) => void;
  onInvite: (userId: string, name: string) => void;
  onSetRole: (userId: string, role: 'controller' | 'listener') => void;
  onRequestTransfer: (member: JamMember) => void;
  onSetMode: (mode: JamMode) => void;
  onLeave: () => void;
  onTransport: (command: Parameters<typeof sendJamTransport>[1]) => void;
  pendingTransfer: JamMember | null;
  onConfirmTransfer: () => void;
  onCancelTransfer: () => void;
}

function JamRoom({
  jamId,
  ownUserId,
  audioRef,
  onBack,
  directoryQuery,
  onDirectoryQueryChange,
  onInvite,
  onSetRole,
  onRequestTransfer,
  onSetMode,
  onLeave,
  onTransport,
  pendingTransfer,
  onConfirmTransfer,
  onCancelTransfer,
}: JamRoomProps) {
  const navigate = useNavigate();
  const { snapshot, connected, denied } = useJamStream(jamId);
  const playback = useJamPlayback(snapshot, ownUserId, audioRef);

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
  const filteredDirectory = (directoryQ.data ?? [])
    .filter((user) => !alreadyInvited.has(user.userId))
    .filter((user) => user.name.toLowerCase().includes(directoryQuery.trim().toLowerCase()));

  if (!snapshot) {
    return (
      <main className="pf-jam">
        <Header />
        <button type="button" className="pf-jam__back" onClick={onBack}>
          ← Volver a tus jams
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
      </main>
    );
  }

  const { jam, present, leaderId } = snapshot;
  const presentSet = new Set(present);
  const canControl =
    connected && ownUserId != null && canControlTransport(jam, presentSet, ownUserId);
  const isPlaying = jam.current.isPlaying;

  return (
    <main className="pf-jam">
      <Header />

      <button type="button" className="pf-jam__back" onClick={onBack}>
        ← Volver a tus jams
      </button>

      {!connected && (
        <p className="pf-jam__status pf-jam__status--error" role="alert">
          Sala desconectada. Reconectando…
        </p>
      )}

      {/* iOS refuses a play() that did not come from a touch. Entering the Jam
          normally provides it, but a reload lands straight in the room with no
          gesture behind it — so offer one instead of staying silent while
          everyone else hears the song. */}
      {playback.needsGesture && (
        <button
          type="button"
          className="pf-jam__listen"
          onClick={() => playback.unlock(audioRef.current)}
        >
          Tocá acá para escuchar en este dispositivo
        </button>
      )}

      {playback.active && jam.mode === 'king' && (
        <p className="pf-jam__status">Este dispositivo es el que suena.</p>
      )}

      <div className="pf-jam__room-header">
        <h1 className="pf-jam__title">{jam.name}</h1>
        <span className="pf-jam__jam-mode">{MODE_LABEL[jam.mode]}</span>
      </div>
      <p className="pf-jam__leader">Líder actual: {memberName(jam.members, leaderId)}</p>

      <div className="pf-jam__transport" role="group" aria-label="Controles de reproducción">
        <button type="button" disabled={!canControl} onClick={() => onTransport({ type: 'prev' })}>
          Anterior
        </button>
        {isPlaying ? (
          <button type="button" disabled={!canControl} onClick={() => onTransport({ type: 'pause' })}>
            Pausar
          </button>
        ) : (
          <button type="button" disabled={!canControl} onClick={() => onTransport({ type: 'play' })}>
            Reproducir
          </button>
        )}
        <button type="button" disabled={!canControl} onClick={() => onTransport({ type: 'next' })}>
          Siguiente
        </button>
      </div>

      <section className="pf-jam__section" aria-label="Integrantes">
        <h2 className="pf-jam__section-title">Integrantes</h2>
        {/* Faces, not a table of names and states. Spotify Jam shows who is
            in the room as a strip of avatars, and it reads instantly: a ring
            means listening now, dimmed means invited and not here yet. The
            previous three-column text layout made a room of two people look
            like a spreadsheet. */}
        <ul className="pf-jam__people">
          {jam.members.map((member) => {
            const pending = member.acceptedAt === null;
            const here = presentSet.has(member.userId);
            const isLeader = leaderId === member.userId;
            return (
              <li key={member.userId} className="pf-jam__person">
                <span
                  className={
                    'pf-jam__avatar' +
                    (here ? ' pf-jam__avatar--here' : '') +
                    (pending ? ' pf-jam__avatar--pending' : '')
                  }
                  aria-hidden="true"
                >
                  {member.name.slice(0, 2).toUpperCase()}
                  {isLeader && <span className="pf-jam__crown" title="Manda la sala" />}
                </span>
                <span className="pf-jam__person-name">{member.name}</span>
                <span className="pf-jam__person-state">
                  {pending ? 'Invitado' : here ? (isLeader ? 'Manda' : 'Escuchando') : 'Fuera'}
                </span>
                {isOwner && !pending && member.userId !== ownUserId && (
                  <span className="pf-jam__person-actions">
                    <button
                      type="button"
                      className="pf-jam__chip"
                      onClick={() =>
                        onSetRole(member.userId, member.role === 'controller' ? 'listener' : 'controller')
                      }
                    >
                      {member.role === 'controller' ? 'Quitar control' : 'Dar control'}
                    </button>
                    <button
                      type="button"
                      className="pf-jam__chip"
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

      <section className="pf-jam__section" aria-label="Cola">
        <h2 className="pf-jam__section-title">Cola</h2>
        {/* The way in has to be HERE. It lived only in each song's ⋮ menu over
            in Música, which is where someone already browsing would find it —
            but not where someone standing in an empty room looks. The owner
            asked how to add music while inside the room, which is the answer. */}
        <button
          type="button"
          className="pf-jam__add-music"
          onClick={() => navigate('/musica')}
        >
          + Buscar música para agregar
        </button>

        {jam.queue.length === 0 ? (
          <p className="pf-jam__status">
            La cola está vacía. Buscá una canción y usá su menú ⋮ → «Agregar a {jam.name}».
          </p>
        ) : (
          <ol className="pf-jam__queue">
            {jam.queue.map((track, index) => (
              <li
                key={`${track.itemId}-${index}`}
                className={`pf-jam__track${index === jam.current.index ? ' pf-jam__track--current' : ''}`}
              >
                {/* Artwork, like every other list of songs in this app. The
                    queue was rendering bare titles while each track carries a
                    coverUrl, which is what made this screen read as a form
                    rather than as part of Música. */}
                <span className="pf-jam__track-art">
                  <CoverImage src={track.coverUrl} loading="lazy" />
                </span>
                <span className="pf-jam__track-text">
                  <span className="pf-jam__track-title">{track.title}</span>
                  {track.artist && <span className="pf-jam__track-artist">{track.artist}</span>}
                </span>
                {index === jam.current.index && (
                  <span className="pf-jam__track-now" aria-label="Sonando ahora">
                    <span /><span /><span />
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {isOwner && (
        <section className="pf-jam__section" aria-label="Administrar Jam">
          <h2 className="pf-jam__section-title">Administrar</h2>

          <label className="pf-jam__mode-select-label">
            Modo
            <select
              className="pf-jam__mode-select"
              value={jam.mode}
              onChange={(event) => onSetMode(event.target.value as JamMode)}
            >
              {(Object.keys(MODE_LABEL) as JamMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </label>

          <input
            type="text"
            className="pf-jam__input"
            placeholder="Buscar usuarios para invitar"
            value={directoryQuery}
            onChange={(event) => onDirectoryQueryChange(event.target.value)}
            aria-label="Buscar usuarios para invitar"
          />
          <ul className="pf-jam__directory">
            {filteredDirectory.map((user) => (
              <li key={user.userId} className="pf-jam__directory-row">
                <span>{user.name}</span>
                <button type="button" onClick={() => onInvite(user.userId, user.name)}>
                  Agregar a la Jam
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isOwner && (
        <button type="button" className="pf-jam__leave" onClick={onLeave}>
          Salir de la Jam
        </button>
      )}

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
