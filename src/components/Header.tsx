import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AdultPinOverlay } from './AdultPinOverlay';
import { PoisonMark } from '../features/onboarding/PoisonMark';
import { useAdultUnlocked } from '../hooks/useAdultUnlocked';
import { useLanguage } from '../hooks/useLanguage';
import { isAdultUnlocked } from '../lib/domain/adultSettings';
import { toggleLanguage } from '../lib/domain/languageSettings';
import './Header.css';

// App header (task: "PoisonFlix brand + search affordance"). Reuses the same
// PoisonMark mark component onboarding already renders (design.md's brand
// asset, not a reinterpretation) instead of duplicating the SVG.
//
// Visual redesign: the header is fixed and starts transparent so it floats
// over the Home/Detail backdrop hero, then gains a solid, blurred background
// once the user scrolls past the hero fold (streaming-app convention). The
// scroll state is local and purely presentational.
//
// LanguageChip (ES⇄EN TMDB metadata toggle, ported from the projector
// reference's `LanguageChip` / `AppSettings.toggleLanguage`,
// projector-feature-map.md §3 top bar): flips the persisted app language
// then invalidates the jellyseerr queries whose results actually carry a
// `language` param (trending/search/detail - see `api/jellyseerr.ts`) so
// they refetch under the new language. `genreRow`/`library`/adult queries are
// deliberately left alone - they don't send `language` (ADR-4).
export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const language = useLanguage();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // +18 access lives in the top bar now (this app's addition - the projector
  // gated it from a Home tile). `useAdultUnlocked` reflects the in-memory
  // session flag; while locked the button opens the PIN overlay, and the
  // effect below sends the user to the dedicated +18 screen the moment the
  // PIN unlocks so entering the code lands you straight on the content.
  const adultUnlocked = useAdultUnlocked();
  const [pinOpen, setPinOpen] = useState(false);
  // Set when the +18 button opened the PIN, so a successful unlock navigates
  // to the +18 screen. A ref (not `pinOpen`) because the overlay closes itself
  // on success in the same render batch as the unlock, so `pinOpen` is already
  // false by the time the effect sees `adultUnlocked` flip true.
  const pendingAdultNav = useRef(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (adultUnlocked && pendingAdultNav.current) {
      pendingAdultNav.current = false;
      navigate('/search_adult');
    }
  }, [adultUnlocked, navigate]);

  const handleToggleLanguage = () => {
    toggleLanguage();
    queryClient.invalidateQueries({ queryKey: ['jellyseerr', 'trending'] });
    queryClient.invalidateQueries({ queryKey: ['jellyseerr', 'search'] });
    queryClient.invalidateQueries({ queryKey: ['jellyseerr', 'detail'] });
  };

  const handleAdultClick = () => {
    if (adultUnlocked) {
      navigate('/search_adult');
    } else {
      pendingAdultNav.current = true;
      setPinOpen(true);
    }
  };

  const handleAdultPinClose = () => {
    setPinOpen(false);
    // Cancelled (Escape / backdrop) without unlocking: drop the pending nav so
    // a later unlock elsewhere never yanks the user to the +18 screen.
    if (!isAdultUnlocked()) pendingAdultNav.current = false;
  };

  return (
    <header className={`pf-header${scrolled ? ' pf-header--scrolled' : ''}`}>
      <Link to="/" className="pf-header__brand" aria-label="PoisonFlix - Inicio">
        <PoisonMark className="pf-header__mark" />
        <span className="pf-header__title">PoisonFlix</span>
      </Link>

      <div className="pf-header__actions">
        <button
          type="button"
          className="pf-header__search pf-header__lang-chip"
          aria-label="Cambiar idioma"
          onClick={handleToggleLanguage}
        >
          <span className="pf-header__search-label">{language === 'es' ? 'ES' : 'EN'}</span>
        </button>

        <Link to="/search" className="pf-header__search" aria-label="Buscar">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
            <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="pf-header__search-label">Buscar</span>
        </Link>

        <button
          type="button"
          className="pf-header__search"
          aria-label={adultUnlocked ? 'Contenido +18' : '+18 contenido bloqueado'}
          onClick={handleAdultClick}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="pf-header__search-label">+18</span>
        </button>

        <Link to="/downloads" className="pf-header__search" aria-label="Descargas">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14"
            />
          </svg>
          <span className="pf-header__search-label">Descargas</span>
        </Link>
      </div>

      <AdultPinOverlay open={pinOpen} onClose={handleAdultPinClose} />
    </header>
  );
}
