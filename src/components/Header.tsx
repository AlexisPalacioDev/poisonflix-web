import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PoisonMark } from '../features/onboarding/PoisonMark';
import './Header.css';

// App header (task: "PoisonFlix brand + search affordance"). Reuses the same
// PoisonMark mark component onboarding already renders (design.md's brand
// asset, not a reinterpretation) instead of duplicating the SVG.
//
// Visual redesign: the header is fixed and starts transparent so it floats
// over the Home/Detail backdrop hero, then gains a solid, blurred background
// once the user scrolls past the hero fold (streaming-app convention). The
// scroll state is local and purely presentational.
export function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`pf-header${scrolled ? ' pf-header--scrolled' : ''}`}>
      <Link to="/" className="pf-header__brand" aria-label="PoisonFlix - Inicio">
        <PoisonMark className="pf-header__mark" />
        <span className="pf-header__title">PoisonFlix</span>
      </Link>

      <Link to="/search" className="pf-header__search" aria-label="Buscar">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="pf-header__search-label">Buscar</span>
      </Link>
    </header>
  );
}
