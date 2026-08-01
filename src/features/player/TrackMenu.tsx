import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { trapTabKey } from '../../lib/dom/focusTrap';
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
// + `BackHandler` to keyboard-operable `<button>`s + an `Escape` key handler
// that closes ONLY the menu (never the player itself, per the projector's
// `TrackMenu.kt:162` `BackHandler(onBack = onDismiss)` intent).

interface TrackMenuScaffoldProps {
  title: string;
  onDismiss: () => void;
  children: React.ReactNode;
}

function TrackMenuScaffold({ title, onDismiss, children }: TrackMenuScaffoldProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Claim focus the instant the sheet appears so keyboard users can move
  // through it immediately (mirrors `focusOnAppear` + `focusGroup` in the
  // Kotlin reference).
  useEffect(() => {
    const firstButton = listRef.current?.querySelector<HTMLButtonElement>('button');
    firstButton?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Close ONLY the menu - stop the event so it never reaches
      // VideoSurface's own key handler (which has no Escape behavior today,
      // but this keeps the menu's keyboard contract explicit either way).
      event.stopPropagation();
      onDismiss();
      return;
    }

    // Trap Tab/Shift+Tab within the sheet so it never escapes to the player
    // controls behind this modal.
    if (listRef.current) trapTabKey(listRef.current, event);
  };

  return (
    <div className="pf-track-menu" role="dialog" aria-label={title} onKeyDown={handleKeyDown}>
      <div className="pf-track-menu__sheet" ref={listRef}>
        <h2 className="pf-track-menu__title">{title}</h2>
        <div className="pf-track-menu__list">{children}</div>
        <button type="button" className="pf-track-menu__option pf-track-menu__option--dismiss" onClick={onDismiss}>
          Cerrar
        </button>
      </div>
    </div>
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
}

export function AudioTrackMenu({ tracks, selectedIndex, onSelect, onDismiss }: AudioTrackMenuProps) {
  const audio = useMemo(() => bestAudioPerLanguage(audioTracksOf(tracks)), [tracks]);
  const labels = useMemo(() => disambiguateLabels(audio.map(trackLabel)), [audio]);

  return (
    <TrackMenuScaffold title="Audio" onDismiss={onDismiss}>
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
}

export function SubtitleTrackMenu({ tracks, selectedIndex, onSelect, onDismiss }: SubtitleTrackMenuProps) {
  const deduped = useMemo(() => bestSubtitlePerLanguage(subtitleTracksOf(tracks)), [tracks]);
  const primary = useMemo(() => deduped.filter((t) => isPrimaryLanguage(t.language)), [deduped]);
  const others = useMemo(() => deduped.filter((t) => !isPrimaryLanguage(t.language)), [deduped]);
  const [showAll, setShowAll] = useState(false);

  return (
    <TrackMenuScaffold title="Subtítulos" onDismiss={onDismiss}>
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
