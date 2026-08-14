import type { ReactNode } from 'react';
import { CoverImage } from './CoverImage';

// The artwork IS the play control. Tapping a cover starts that track; tapping
// the cover of the track already loaded in the player pauses or resumes it —
// the gesture the owner asked for ("al dar click en la caratula se dara play o
// pausa automaticamente").
//
// Only the track that is loaded in the player carries a glyph, and that glyph
// is a STATUS MARKER, not a control: `aria-hidden`, so a screen reader hears
// one button (the cover) and not two. Every other cover shows nothing at all —
// no disc, no hover reveal — because a green disc on all forty covers said
// nothing about which one was making noise.
//
// The click surface is an absolutely positioned <button> laid over the artwork
// rather than a <button> wrapping it: the rail cards stack a like and a ⋮ menu
// on the same cover, and a button cannot contain another button. Those siblings
// sit at `z-index: 2` and stay pressable.

function PlayGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

export interface PlayableCoverProps {
  /** The cover URL, or null when there is none (CoverImage draws ♪). */
  src: string | null | undefined;
  /** Class for the sized wrapper — `pf-music__art` in lists, `pf-music__rec-art`
   *  on cards. Kept a prop so this component owns no layout of its own. */
  className: string;
  /** Accessible name for the play action, e.g. `Reproducir Song Title`. */
  label: string;
  /** Accessible name while this track is active AND playing, e.g. `Pausar Song
   *  Title`. It carries the title for the same reason `label` does: this button
   *  IS the cover now, so a list renders forty of them, and a control announced
   *  as bare "Pausar" tells a screen-reader user nothing about which one they
   *  landed on. Falls back to `Pausar` only where the caller has no title. */
  pauseLabel?: string;
  /** Start this track, or toggle it when it is already the loaded one. The call
   *  site decides which, exactly as it did when the row owned a play button. */
  onClick: () => void;
  /** True when this cover's track is the one currently loaded in the player. */
  active?: boolean;
  /** The player's play/pause state — only consulted while `active`. */
  isPlaying?: boolean;
  /** Size of the status glyph: list covers are 52px, rail covers ~150px. */
  glyphSize?: number;
  loading?: 'lazy' | 'eager';
  /** Extra chrome that lives on the artwork (the like, a kind tag). Rendered
   *  after the click surface so it stacks above it. */
  children?: ReactNode;
}

export function PlayableCover({
  src,
  className,
  label,
  pauseLabel = 'Pausar',
  onClick,
  active = false,
  isPlaying = false,
  glyphSize = 18,
  loading,
  children,
}: PlayableCoverProps) {
  const showPause = active && isPlaying;
  return (
    <div className={`${className} pf-music__art-host`}>
      <CoverImage src={src} loading={loading} />
      <button
        type="button"
        className="pf-music__art-btn"
        onClick={onClick}
        // ONE signal, not two. `aria-pressed` alongside a label that ALREADY
        // flips between "Reproducir X" and "Pausar X" makes a screen reader
        // announce "Pausar X, toggle button, pressed" — which reads as "the
        // pause button is pressed" when what is true is "the track is
        // playing". The NowPlayingBar's own transport settled this the same
        // way: a changing label and no pressed state.
        aria-label={showPause ? pauseLabel : label}
      >
        {active && (
          <span className="pf-music__art-state" aria-hidden="true">
            {showPause ? <PauseGlyph size={glyphSize} /> : <PlayGlyph size={glyphSize} />}
          </span>
        )}
      </button>
      {children}
    </div>
  );
}
