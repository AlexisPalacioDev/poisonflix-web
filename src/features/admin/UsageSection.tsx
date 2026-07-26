import { useActiveSessions, useServerUsage } from '../../hooks/useServerUsage';

// "Uso del servidor" — who has been using it lately, and who is playing right
// now. Read-only: this panel observes, it never acts on a user.
//
// The window is bounded by Jellyfin's activity log, which is rolling. The
// caption says "últimos N días" and not "histórico" on purpose — implying
// completeness we don't have would be the one way this panel could lie.

const WINDOW_DAYS = 30;

function relativeDay(date: Date | null, now: Date): string {
  if (!date) return 'nunca';
  const days = Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

// A bar per day, scaled to the busiest one. Deliberately plain: this answers
// "is it being used, and is that changing", not "exactly how much on the 14th".
function Sparkline({ values }: { values: number[] }) {
  const peak = Math.max(1, ...values);
  return (
    <div
      className="pf-usage__spark"
      role="img"
      aria-label={`Reproducciones por día en los últimos ${values.length} días`}
    >
      {values.map((value, index) => (
        <span
          key={index}
          className="pf-usage__spark-bar"
          style={{ height: `${Math.max(4, Math.round((value / peak) * 100))}%` }}
          title={`${value}`}
        />
      ))}
    </div>
  );
}

export function UsageSection() {
  const now = new Date();
  const usage = useServerUsage(WINDOW_DAYS, true, now);
  const sessions = useActiveSessions(true);

  return (
    <section className="pf-admin__section">
      <h2 className="pf-admin__section-title">Uso del servidor</h2>

      {usage.isError ? (
        <p className="pf-usage__empty">
          No se pudo leer el registro de actividad de Jellyfin. Necesita una cuenta
          administradora en Jellyfin, no solo en PoisonFlix.
        </p>
      ) : usage.isLoading ? (
        <p className="pf-usage__empty">Cargando uso…</p>
      ) : (
        <>
          <p className="pf-usage__caption">
            Últimos {WINDOW_DAYS} días · {usage.totalPlays} reproducciones · el registro de
            actividad de Jellyfin es rotativo, así que esto es lo reciente, no el histórico
            completo.
          </p>

          {usage.totalPlays > 0 && <Sparkline values={usage.daily} />}

          {usage.users.length === 0 ? (
            <p className="pf-usage__empty">Nadie reprodujo nada en la ventana.</p>
          ) : (
            <ul className="pf-usage__users">
              {usage.users.map((user) => (
                <li key={user.userId} className="pf-usage__user">
                  <div className="pf-usage__user-main">
                    <span className="pf-usage__user-name">{user.name}</span>
                    <span className="pf-usage__user-sub">
                      {user.audioPlays} temas · {user.videoPlays} videos
                    </span>
                  </div>
                  <div className="pf-usage__user-meta">
                    <span className="pf-usage__user-total">{user.totalPlays}</span>
                    <span className="pf-usage__user-sub">{relativeDay(user.lastActivity, now)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="pf-usage__subheading">Ahora mismo</h3>
      {sessions.isError ? (
        <p className="pf-usage__empty">No se pudieron leer las sesiones activas.</p>
      ) : sessions.playing.length === 0 ? (
        <p className="pf-usage__empty">Nadie está reproduciendo nada.</p>
      ) : (
        <ul className="pf-usage__live">
          {sessions.playing.map((session, index) => (
            <li key={session.Id ?? index} className="pf-usage__live-row">
              <span className="pf-usage__dot" aria-hidden="true" />
              <span className="pf-usage__user-name">{session.UserName ?? 'Alguien'}</span>
              <span className="pf-usage__user-sub">
                {session.NowPlayingItem?.Name}
                {session.NowPlayingItem?.Artists?.[0]
                  ? ` — ${session.NowPlayingItem.Artists[0]}`
                  : ''}
                {session.Client ? ` · ${session.Client}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
