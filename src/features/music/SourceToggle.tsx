import type { MusicSource } from '../../api/schemas/music';

// Segmented control for the search source (Spotify-style pill switch). Each
// option is a native <button> so `installSpatialNavigation` (TV D-pad) reaches
// it with no extra wiring. `auto` is the default — the worker picks the best
// surface; the explicit options force YT Music (clean metadata) or YouTube
// (broader catalogue) so the user can override.

const OPTIONS: { id: MusicSource; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'ytmusic', label: 'YT Music' },
  { id: 'youtube', label: 'YouTube' },
];

export function SourceToggle({
  value,
  onChange,
}: {
  value: MusicSource;
  onChange: (source: MusicSource) => void;
}) {
  return (
    <div
      className="pf-music__source"
      role="group"
      aria-label="Fuente de búsqueda"
    >
      {OPTIONS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={`pf-music__source-btn${value === id ? ' pf-music__source-btn--active' : ''}`}
          onClick={() => onChange(id)}
          aria-pressed={value === id}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
