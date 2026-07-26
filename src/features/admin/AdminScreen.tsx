import { useState } from 'react';
import { UsageSection } from './UsageSection';
import { Navigate } from 'react-router-dom';
import { ConfirmOverlay } from '../../components/ConfirmOverlay';
import { Header } from '../../components/Header';
import { StatusBadge } from '../../components/StatusBadge';
import { useAdminUsers, useResetUserPassword } from '../../hooks/useAdminUsers';
import { useAdminStorage } from '../../hooks/useAdminStorage';
import { useAuth } from '../../hooks/useAuth';
import { useCreateInvite, useInvites, useRevokeInvite } from '../../hooks/useInvites';
import type { Invite } from '../../api/schemas/bff';
import { validatePassword } from '../../lib/domain/registerValidation';
import { mapResetPasswordError } from '../register/errorMessage';
import './admin.css';

// Admin panel (register spec): invite generation/revocation + per-user
// password reset. `RouteGuard` (routes/index.tsx) only guarantees a session
// exists; the isAdmin check below is this screen's own gate - a UX
// convenience, not the real authorization boundary (the BFF re-enforces
// admin-only on every write regardless, same rationale as Downloads' +18
// delete flow).

const INVITE_STATUS_LABEL: Record<Invite['status'], string> = {
  active: 'ACTIVO',
  used: 'USADO',
  expired: 'EXPIRADO',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const GIB = 1024 ** 3;

function formatBytes(bytes: number): string {
  const gib = bytes / GIB;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TB`;
  return `${gib.toFixed(1)} GB`;
}

// Free-space severity for the storage bar's color: comfortable until 75% used,
// warning at 75-90%, danger past 90% (the disk-full incident that motivated
// this card sat at ~100%).
function storageSeverity(usedPercent: number): 'ok' | 'warn' | 'danger' {
  if (usedPercent >= 90) return 'danger';
  if (usedPercent >= 75) return 'warn';
  return 'ok';
}

export function AdminScreen() {
  const { session } = useAuth();
  const isAdmin = session?.isAdmin === true;

  const invitesQuery = useInvites();
  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();

  const usersQuery = useAdminUsers();
  const resetPassword = useResetUserPassword();

  const storageQuery = useAdminStorage();

  const [expiresInDays, setExpiresInDays] = useState('');
  const [lastCreatedCode, setLastCreatedCode] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccessId, setResetSuccessId] = useState<string | null>(null);

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  function handleGenerate() {
    setCreateError(null);
    setCopyFeedback(false);
    const trimmed = expiresInDays.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
      setCreateError('Ingresá un número de días válido, o dejalo vacío para que no expire.');
      return;
    }

    createInvite.mutate(
      { expiresInDays: parsed },
      {
        onSuccess: (invite) => setLastCreatedCode(invite.code),
        onError: () => setCreateError('No se pudo generar el código. Intentá de nuevo.'),
      },
    );
  }

  function handleCopyLink(code: string) {
    const link = `${window.location.origin}/register?code=${encodeURIComponent(code)}`;
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
      })
      .catch(() => setCreateError('No se pudo copiar el link.'));
  }

  function handleConfirmRevoke() {
    const code = pendingRevoke;
    if (!code) return;
    setPendingRevoke(null);
    setRevokeError(null);
    revokeInvite.mutate(code, {
      onError: () => setRevokeError('No se pudo revocar el código. Intentá de nuevo.'),
    });
  }

  function openResetForm(userId: string) {
    setResetTargetId(userId);
    setResetPasswordValue('');
    setResetError(null);
    setResetSuccessId(null);
  }

  function closeResetForm() {
    setResetTargetId(null);
    setResetPasswordValue('');
    setResetError(null);
  }

  function handleResetSubmit(userId: string) {
    const validationError = validatePassword(resetPasswordValue);
    if (validationError) {
      setResetError(validationError);
      return;
    }
    setResetError(null);
    resetPassword.mutate(
      { userId, newPassword: resetPasswordValue },
      {
        onSuccess: () => {
          setResetTargetId(null);
          setResetPasswordValue('');
          setResetSuccessId(userId);
          setTimeout(() => setResetSuccessId((current) => (current === userId ? null : current)), 3000);
        },
        onError: (err) => setResetError(mapResetPasswordError(err)),
      },
    );
  }

  return (
    <main className="pf-admin">
      <Header />

      <div className="pf-admin__content">
        <h1 className="pf-admin__title">Administración</h1>

        <section className="pf-admin__section">
          <h2 className="pf-admin__section-title">Almacenamiento</h2>

          {storageQuery.isLoading && <p className="pf-admin__status">Cargando almacenamiento…</p>}
          {storageQuery.isError && (
            <p className="pf-admin__status pf-admin__status--error">No se pudo cargar el almacenamiento.</p>
          )}

          {storageQuery.data &&
            (() => {
              const { freeSpace, totalSpace } = storageQuery.data;
              const used = Math.max(0, totalSpace - freeSpace);
              const usedPercent = totalSpace > 0 ? Math.min(100, (used / totalSpace) * 100) : 0;
              const severity = storageSeverity(usedPercent);
              return (
                <div className={`pf-admin__storage pf-admin__storage--${severity}`}>
                  <div className="pf-admin__storage-summary">
                    <span className="pf-admin__storage-free">{formatBytes(freeSpace)} libres</span>
                    <span className="pf-admin__storage-total">de {formatBytes(totalSpace)}</span>
                  </div>
                  <div
                    className="pf-admin__storage-bar"
                    role="progressbar"
                    aria-valuenow={Math.round(usedPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Espacio usado del servidor"
                  >
                    <div className="pf-admin__storage-fill" style={{ width: `${usedPercent}%` }} />
                  </div>
                  <span className="pf-admin__storage-caption">{Math.round(usedPercent)}% usado</span>
                </div>
              );
            })()}
        </section>

        <UsageSection />

        <section className="pf-admin__section">
          <h2 className="pf-admin__section-title">Invitaciones</h2>

          <div className="pf-admin__generate">
            <div className="pf-admin__generate-field">
              <label className="pf-admin__label" htmlFor="admin-invite-expires">
                Expira en (días)
              </label>
              <input
                id="admin-invite-expires"
                className="pf-admin__input"
                type="number"
                min={1}
                placeholder="Nunca"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="pf-admin__button pf-admin__button--primary"
              onClick={handleGenerate}
              disabled={createInvite.isPending}
            >
              {createInvite.isPending ? 'Generando…' : 'Generar código'}
            </button>
          </div>

          {createError && (
            <p className="pf-admin__error" role="alert">
              {createError}
            </p>
          )}

          {lastCreatedCode && (
            <div className="pf-admin__new-code" role="status">
              <span className="pf-admin__new-code-label">Código nuevo</span>
              <code className="pf-admin__new-code-value">{lastCreatedCode}</code>
              <button type="button" className="pf-admin__button" onClick={() => handleCopyLink(lastCreatedCode)}>
                {copyFeedback ? '¡Copiado!' : 'Copiar link'}
              </button>
            </div>
          )}

          {invitesQuery.isLoading && <p className="pf-admin__status">Cargando invitaciones…</p>}
          {invitesQuery.isError && (
            <p className="pf-admin__status pf-admin__status--error">No se pudieron cargar las invitaciones.</p>
          )}
          {revokeError && (
            <p className="pf-admin__error" role="alert">
              {revokeError}
            </p>
          )}

          {invitesQuery.data && invitesQuery.data.length > 0 && (
            <div className="pf-admin__table-wrap">
              <table className="pf-admin__table">
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Estado</th>
                    <th>Creado</th>
                    <th>Usado por</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {invitesQuery.data.map((invite) => (
                    <tr key={invite.code}>
                      <td>
                        <code>{invite.code}</code>
                      </td>
                      <td>
                        <StatusBadge variant={invite.status} label={INVITE_STATUS_LABEL[invite.status]} />
                      </td>
                      <td>{formatDate(invite.createdAt)}</td>
                      <td>{invite.usedBy ?? '—'}</td>
                      <td>
                        {invite.status === 'active' && (
                          <button
                            type="button"
                            className="pf-admin__button pf-admin__button--danger"
                            onClick={() => setPendingRevoke(invite.code)}
                          >
                            Revocar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {invitesQuery.data && invitesQuery.data.length === 0 && (
            <p className="pf-admin__status">Todavía no generaste ningún código.</p>
          )}
        </section>

        <section className="pf-admin__section">
          <h2 className="pf-admin__section-title">Usuarios</h2>

          {usersQuery.isLoading && <p className="pf-admin__status">Cargando usuarios…</p>}
          {usersQuery.isError && (
            <p className="pf-admin__status pf-admin__status--error">No se pudieron cargar los usuarios.</p>
          )}

          {usersQuery.data && (
            <ul className="pf-admin__users">
              {usersQuery.data.map((user) => (
                <li key={user.id} className="pf-admin__user">
                  <div className="pf-admin__user-info">
                    <span className="pf-admin__user-name">{user.name}</span>
                    {user.isAdmin && <span className="pf-admin__admin-badge">ADMIN</span>}
                  </div>

                  {resetTargetId === user.id ? (
                    <div className="pf-admin__reset-form">
                      <input
                        type="password"
                        className="pf-admin__input"
                        placeholder="Nueva contraseña"
                        autoComplete="new-password"
                        value={resetPasswordValue}
                        onChange={(e) => setResetPasswordValue(e.target.value)}
                        disabled={resetPassword.isPending}
                      />
                      <button
                        type="button"
                        className="pf-admin__button pf-admin__button--primary"
                        onClick={() => handleResetSubmit(user.id)}
                        disabled={resetPassword.isPending}
                      >
                        {resetPassword.isPending ? 'Guardando…' : 'Guardar'}
                      </button>
                      <button type="button" className="pf-admin__button" onClick={closeResetForm}>
                        Cancelar
                      </button>
                      {resetError && (
                        <p className="pf-admin__error" role="alert">
                          {resetError}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="pf-admin__user-actions">
                      {resetSuccessId === user.id && (
                        <span className="pf-admin__reset-success">Contraseña actualizada</span>
                      )}
                      <button type="button" className="pf-admin__button" onClick={() => openResetForm(user.id)}>
                        Resetear contraseña
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ConfirmOverlay
        open={pendingRevoke != null}
        title="Revocar invitación"
        message={pendingRevoke ? `¿Revocar el código "${pendingRevoke}"? Ya no se va a poder usar.` : ''}
        confirmLabel="Sí, revocar"
        dismissLabel="No, mantener"
        danger
        onConfirm={handleConfirmRevoke}
        onDismiss={() => setPendingRevoke(null)}
      />
    </main>
  );
}
