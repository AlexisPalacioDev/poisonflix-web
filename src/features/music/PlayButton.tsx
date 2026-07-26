// Compact, icon-only play button for song rows — a ▶ glyph in a round green
// button (Spotify-style), replacing the old "Reproducir" TEXT pills. The visible
// label is intentionally absent; `label` is the accessible name kept for screen
// readers and TV D-pad focus (always "Reproducir …"). The same play SVG the
// NowPlayingBar uses, so the whole Música surface reads as one system.
//
// The big labelled "Reproducir álbum" / "Reproducir" HEADER buttons on detail
// pages are deliberately NOT this — they stay text so the primary action reads
// clearly.

function PlayGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

// Same pause SVG the NowPlayingBar uses, so a row that's sounding reads as one
// system with the bar instead of showing a stale ▶ on the active track.
function PauseGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

export interface PlayButtonProps {
  /** Fired on click. For an inactive row `() => playNow(tracks, index)`; for the
   *  active row `() => toggle()` so tapping the sounding track pauses/resumes it. */
  onClick: () => void;
  /** Full accessible name, e.g. `Reproducir Song Title`. Kept for a11y/D-pad. */
  label: string;
  disabled?: boolean;
  size?: number;
  /** True when this row's track is the one currently loaded in the player. */
  active?: boolean;
  /** The player's play/pause state — only consulted while `active`. Active +
   *  playing flips the glyph to a pause icon so the list mirrors the bar. */
  isPlaying?: boolean;
}

export function PlayButton({
  onClick,
  label,
  disabled,
  size = 20,
  active = false,
  isPlaying = false,
}: PlayButtonProps) {
  const showPause = active && isPlaying;
  return (
    <button
      type="button"
      className={`pf-music__play-icon${active ? ' pf-music__play-icon--active' : ''}`}
      onClick={onClick}
      aria-label={showPause ? 'Pausar' : label}
      aria-pressed={active ? isPlaying : undefined}
      disabled={disabled}
    >
      {showPause ? <PauseGlyph size={size} /> : <PlayGlyph size={size} />}
    </button>
  );
}
