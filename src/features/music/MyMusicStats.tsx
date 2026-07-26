import { useMyMusicStats } from '../../hooks/useMyMusicStats';
import { formatMinutes } from '../../lib/domain/usageStats';

// "Tu música": the user's own listening, back to them. Only rendered once they
// have history — an empty stats panel on a fresh account is noise, and the feed
// above it already explains itself.

export function MyMusicStats() {
  const stats = useMyMusicStats();

  if (stats.isLoading || !stats.hasHistory) return null;

  return (
    <section className="pf-music__section" aria-label="Tu música en números">
      <h2 className="pf-music__heading">Tu música en números</h2>

      <div className="pf-stats">
        <div className="pf-stats__tiles">
          <div className="pf-stats__tile">
            <span className="pf-stats__value">{stats.totalPlays}</span>
            <span className="pf-stats__label">reproducciones</span>
          </div>
          <div className="pf-stats__tile">
            <span className="pf-stats__value">{formatMinutes(stats.minutes)}</span>
            {/* Honest label: Jellyfin stores no per-play duration, so this is
                play count x track length, not measured time. */}
            <span className="pf-stats__label">escuchadas (estimado)</span>
          </div>
        </div>

        <div className="pf-stats__lists">
          <div className="pf-stats__list">
            <h3 className="pf-stats__list-title">Tus artistas</h3>
            <ol className="pf-stats__ol">
              {stats.artists.map((entry) => (
                <li key={entry.label} className="pf-stats__row">
                  <span className="pf-stats__row-label">{entry.label}</span>
                  <span className="pf-stats__row-count">{entry.plays}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="pf-stats__list">
            <h3 className="pf-stats__list-title">Tus temas</h3>
            <ol className="pf-stats__ol">
              {stats.tracks.map((entry) => (
                <li key={`${entry.label}-${entry.detail ?? ''}`} className="pf-stats__row">
                  <span className="pf-stats__row-label">
                    {entry.label}
                    {entry.detail && <span className="pf-stats__row-sub"> · {entry.detail}</span>}
                  </span>
                  <span className="pf-stats__row-count">{entry.plays}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
