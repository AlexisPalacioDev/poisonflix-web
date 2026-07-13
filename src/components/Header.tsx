import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PoisonMark } from '../features/onboarding/PoisonMark';
import { useLanguage } from '../hooks/useLanguage';
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

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleToggleLanguage = () => {
    toggleLanguage();
    queryClient.invalidateQueries({ queryKey: ['jellyseerr', 'trending'] });
    queryClient.invalidateQueries({ queryKey: ['jellyseerr', 'search'] });
    queryClient.invalidateQueries({ queryKey: ['jellyseerr', 'detail'] });
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
    </header>
  );
}
