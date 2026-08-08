import { useEffect, useMemo, useRef, useState } from 'react';
import { OverlayShell } from '../../components/overlay/OverlayShell';
import type { SubtitleDeliveryMethod } from '../../api/schemas/jellyfin';
import {
  audioTracksOf,
  bestAudioPerLanguage,
  bestSubtitlePerLanguage,
  disambiguateLabels,
  isBurnedInSubtitle,
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

export interface TrackMenuScaffoldProps {
  title: string;
  onDismiss: () => void;
  children: React.ReactNode;
  /** Portal target, forwarded straight to `OverlayShell`. Needed so the menu
   *  stays inside the player's fullscreen surface instead of always
   *  portalling to `document.body` - see `AudioTrackMenuProps.container`. */
  container?: Element | null;
}

// Exported so `EpisodeMenu` (episode prev/next/jump navigation) can reuse
// this exact scaffold + option button instead of re-implementing the same
// OverlayShell dialog pattern a third time.
export function TrackMenuScaffold({ title, onDismiss, children, container }: TrackMenuScaffoldProps) {
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

export interface TrackOptionButtonProps {
  label: string;
  isSelected: boolean;
  onClick: () => void;
}

export function TrackOptionButton({ label, isSelected, onClick }: TrackOptionButtonProps) {
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
  /** Second, SIMULTANEOUS subtitle (owner request: "me gustaría poder leer
   *  también los sub en inglés y en español" - a language-learning feature,
   *  read one language while listening + the other alongside for meaning.
   *  `null` == off; the default single-subtitle behavior above is completely
   *  unchanged when this stays `null`. See `VideoSurface.tsx`'s header for
   *  why this is rendered by a custom overlay instead of a second `<track>`. */
  secondSelectedIndex: number | null;
  onSelectSecond: (track: MediaStreamTrack | null) => void;
  /** Per-stream DeliveryMethod for the CURRENT resolved source - needed here
   *  to warn about (and block picking) a pair where either track is already
   *  server-burned into the video's pixels (`DeliveryMethod: 'Encode'` -
   *  `isBurnedInSubtitle`), instead of silently letting the user create a
   *  combination `VideoSurface` cannot actually render as text. */
  subtitleDeliveryMethods: Record<number, SubtitleDeliveryMethod>;
  /** Word-highlight toggle (owner request: "resaltar la palabra que se está
   *  pronunciando" - English only, see `subtitleCues.ts`'s header). Owner
   *  asked this to live "junto a Segundo subtítulo", so it's a section of
   *  THIS menu rather than a separate settings surface, even though it's a
   *  display preference and not a track pick like everything above it. */
  wordHighlightEnabled: boolean;
  onToggleWordHighlight: () => void;
}

export function SubtitleTrackMenu({
  tracks,
  selectedIndex,
  onSelect,
  onDismiss,
  container,
  secondSelectedIndex,
  onSelectSecond,
  subtitleDeliveryMethods,
  wordHighlightEnabled,
  onToggleWordHighlight,
}: SubtitleTrackMenuProps) {
  const deduped = useMemo(() => bestSubtitlePerLanguage(subtitleTracksOf(tracks)), [tracks]);
  const primary = useMemo(() => deduped.filter((t) => isPrimaryLanguage(t.language)), [deduped]);
  const others = useMemo(() => deduped.filter((t) => !isPrimaryLanguage(t.language)), [deduped]);
  const [showAll, setShowAll] = useState(false);

  // The currently active PRIMARY subtitle track object (not just its index)
  // - needed below to check whether IT is burned in, which blocks the second
  // slot entirely (an Encode-delivered primary has no text for our overlay
  // to render alongside - see VideoSurface.tsx's header).
  const selectedTrack = useMemo(() => tracks.find((t) => t.index === selectedIndex) ?? null, [tracks, selectedIndex]);
  const selectedIsBurnedIn = selectedTrack ? isBurnedInSubtitle(subtitleDeliveryMethods[selectedTrack.index]) : false;
  // Candidates for the SECOND slot: every deduped language except whichever
  // one is already the primary - picking the same track (or same language)
  // twice would render the identical line in both rows.
  const secondCandidates = useMemo(() => deduped.filter((t) => t.index !== selectedIndex), [deduped, selectedIndex]);

  return (
    <TrackMenuScaffold title="Subtítulos" onDismiss={onDismiss} container={container}>
      {/* `role="group"` + `aria-label` - NOT purely decorative: the second
          slot below deliberately reuses several of these SAME language
          labels (e.g. "Inglés" can be both the primary pick and a candidate
          for the second slot at once), so a query for "the primary Inglés
          button" needs an unambiguous container to scope into. Existing
          single-subtitle behavior/markup is otherwise unchanged - this is
          the exact same flat button list as before dual subtitles existed,
          just wrapped. */}
      <div className="pf-track-menu__group" role="group" aria-label="Subtítulo principal">
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
      </div>

      <div className="pf-track-menu__divider" role="separator" />
      <h3 className="pf-track-menu__subheading">Segundo subtítulo</h3>

      <div className="pf-track-menu__group" role="group" aria-label="Segundo subtítulo">
        {selectedIndex == null ? (
          <p className="pf-track-menu__note">Elegí primero un subtítulo para poder sumar un segundo idioma.</p>
        ) : selectedIsBurnedIn ? (
          <p className="pf-track-menu__note">
            Este subtítulo está incrustado en el video: no se puede combinar con otro.
          </p>
        ) : (
          <>
            <TrackOptionButton
              label="Ninguno"
              isSelected={secondSelectedIndex == null}
              onClick={() => onSelectSecond(null)}
            />
            {secondCandidates.map((track) => {
              const blocked = isBurnedInSubtitle(subtitleDeliveryMethods[track.index]);
              if (blocked) {
                // Shown, not hidden - the owner asked that a broken pair be
                // explained in the UI rather than silently unavailable.
                return (
                  <div key={track.index} className="pf-track-menu__option pf-track-menu__option--blocked" aria-disabled="true">
                    <span>{trackLabel(track)}</span>
                    <span className="pf-track-menu__note-inline">Incrustado en el video</span>
                  </div>
                );
              }
              return (
                <TrackOptionButton
                  key={track.index}
                  label={trackLabel(track)}
                  isSelected={track.index === secondSelectedIndex}
                  onClick={() => onSelectSecond(track)}
                />
              );
            })}
          </>
        )}
      </div>

      <div className="pf-track-menu__divider" role="separator" />
      <h3 className="pf-track-menu__subheading">Resaltado de palabra</h3>

      <div className="pf-track-menu__group" role="group" aria-label="Resaltado de palabra">
        {/* Reuses the same "checked option" pattern as every pick above -
            not a track choice, but visually it IS an on/off selection, and
            `TrackOptionButton` already renders that state (checkmark + gold
            fill) consistently with the rest of this menu. English only (see
            `subtitleCues.ts`'s header): a Spanish row never gets per-word
            highlighting regardless of this toggle, so the label says so
            rather than implying it affects every subtitle shown. */}
        <TrackOptionButton
          label="Resaltar la palabra que se está pronunciando (inglés)"
          isSelected={wordHighlightEnabled}
          onClick={onToggleWordHighlight}
        />
        {/* This preference only has a visible effect once BOTH a primary and
            a second subtitle are active (dual mode, above) and one of them
            is English - it's a no-op with a single subtitle or a non-English
            pair. Stated plainly rather than computing "is it live right now"
            here: that would need to duplicate `dualSubtitlesActive`'s own
            burned-in/language checks (`VideoSurface.tsx`'s header) a second
            time in this component just to answer a question the label
            already answers well enough on its own. */}
        <p className="pf-track-menu__note">
          Solo tiene efecto con inglés activo como subtítulo principal o segundo.
        </p>
      </div>
    </TrackMenuScaffold>
  );
}
