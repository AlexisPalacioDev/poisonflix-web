import { useEffect, useMemo, useRef, useState } from 'react';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import {
  audioTracksOf,
  bestAudioPerLanguage,
  bestSubtitlePerLanguage,
  disambiguateLabels,
  isPrimaryLanguage,
  subtitleTracksOf,
  trackLabel,
  type MediaStreamTrack,
} from './mediaStreamTracks';
import './TrackMenu.css';

// Audio/subtitle track picker overlay (player spec §8, projector-feature-map.md
// §8, ← `TrackMenu.kt`'s `AudioTrackMenu`/`SubtitleTrackMenu`). A focusable
// list rendered as a centered sheet over the player, dimming the rest of the
// screen - same shape as the Kotlin reference, adapted from D-pad `Button`s
// + `BackHandler` to keyboard-operable `<button>`s.
//
// Dismissal (backdrop click, Escape, focus trap/return, scroll-lock) is owned
// by the shared `OverlayShell` (design D: `sdd/mobile-music-overhaul`) rather
// than a component-local handler - `.pf-track-menu` is now OverlayShell's own
// backdrop node (it already had the dim/flex-center styling that role needs).

interface TrackMenuScaffoldProps {
  title: string;
  onDismiss: () => void;
  children: React.ReactNode;
  /** Portal target, forwarded straight to `OverlayShell`. Needed so the menu
   *  stays inside the player's fullscreen surface instead of always
   *  portalling to `document.body` - see `AudioTrackMenuProps.container`. */
  container?: Element | null;
}

function TrackMenuScaffold({ title, onDismiss, children, container }: TrackMenuScaffoldProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Claim focus the instant the sheet appears so keyboard users can move
  // through it immediately (mirrors `focusOnAppear` + `focusGroup` in the
  // Kotlin reference).
  useEffect(() => {
    const firstButton = listRef.current?.querySelector<HTMLButtonElement>('button');
    firstButton?.focus();
  }, []);

  return (
    <OverlayShell
      variant="dialog"
      onDismiss={onDismiss}
      className="pf-track-menu"
      role="dialog"
      ariaModal
      ariaLabel={title}
      container={container}
    >
      <div className="pf-track-menu__sheet" ref={listRef}>
        <h2 className="pf-track-menu__title">{title}</h2>
        <div className="pf-track-menu__list">{children}</div>
        <button type="button" className="pf-track-menu__option pf-track-menu__option--dismiss" onClick={onDismiss}>
          Cerrar
        </button>
      </div>
    </OverlayShell>
  );
}

interface TrackOptionButtonProps {
  label: string;
  isSelected: boolean;
  onClick: () => void;
}

function TrackOptionButton({ label, isSelected, onClick }: TrackOptionButtonProps) {
  return (
    <button
      type="button"
      className={`pf-track-menu__option${isSelected ? ' pf-track-menu__option--selected' : ''}`}
      onClick={onClick}
      aria-pressed={isSelected}
    >
      {isSelected ? <span className="pf-track-menu__check" aria-hidden="true">✓</span> : null}
      {label}
    </button>
  );
}

export interface AudioTrackMenuProps {
  tracks: MediaStreamTrack[];
  selectedIndex: number | null;
  onSelect: (track: MediaStreamTrack) => void;
  onDismiss: () => void;
  /** Portal target. Defaults to `document.body`. Pass the player's fullscreen
   *  surface (`containerRef.current` in `VideoSurface`) so the menu stays
   *  inside the real Fullscreen API's element (otherwise never rendered) and
   *  above a pseudo-fullscreen surface's high z-index (otherwise painted
   *  behind the video) - real-Chrome audit finding, `sdd/mobile-music-overhaul`. */
  container?: Element | null;
}

export function AudioTrackMenu({ tracks, selectedIndex, onSelect, onDismiss, container }: AudioTrackMenuProps) {
  const audio = useMemo(() => bestAudioPerLanguage(audioTracksOf(tracks)), [tracks]);
  const labels = useMemo(() => disambiguateLabels(audio.map(trackLabel)), [audio]);

  return (
    <TrackMenuScaffold title="Audio" onDismiss={onDismiss} container={container}>
      {audio.map((track, i) => (
        <TrackOptionButton
          key={track.index}
          label={labels[i]}
          isSelected={track.index === selectedIndex}
          onClick={() => onSelect(track)}
        />
      ))}
    </TrackMenuScaffold>
  );
}

export interface SubtitleTrackMenuProps {
  tracks: MediaStreamTrack[];
  /** `null` == "Ninguno" selected. */
  selectedIndex: number | null;
  onSelect: (track: MediaStreamTrack | null) => void;
  onDismiss: () => void;
  /** Portal target - see `AudioTrackMenuProps.container`. */
  container?: Element | null;
}

export function SubtitleTrackMenu({ tracks, selectedIndex, onSelect, onDismiss, container }: SubtitleTrackMenuProps) {
  const deduped = useMemo(() => bestSubtitlePerLanguage(subtitleTracksOf(tracks)), [tracks]);
  const primary = useMemo(() => deduped.filter((t) => isPrimaryLanguage(t.language)), [deduped]);
  const others = useMemo(() => deduped.filter((t) => !isPrimaryLanguage(t.language)), [deduped]);
  const [showAll, setShowAll] = useState(false);

  return (
    <TrackMenuScaffold title="Subtítulos" onDismiss={onDismiss} container={container}>
      <TrackOptionButton label="Ninguno" isSelected={selectedIndex == null} onClick={() => onSelect(null)} />
      {primary.map((track) => (
        <TrackOptionButton
          key={track.index}
          label={trackLabel(track)}
          isSelected={track.index === selectedIndex}
          onClick={() => onSelect(track)}
        />
      ))}
      {others.length > 0 && !showAll ? (
        <button type="button" className="pf-track-menu__option pf-track-menu__option--expand" onClick={() => setShowAll(true)}>
          Más subtítulos ({others.length})
        </button>
      ) : null}
      {showAll
        ? others.map((track) => (
            <TrackOptionButton
              key={track.index}
              label={trackLabel(track)}
              isSelected={track.index === selectedIndex}
              onClick={() => onSelect(track)}
            />
          ))
        : null}
    </TrackMenuScaffold>
  );
}
