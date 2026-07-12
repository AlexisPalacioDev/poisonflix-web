import { Link } from 'react-router-dom';
import { PoisonMark } from '../features/onboarding/PoisonMark';
import './Header.css';

// App header (task: "PoisonFlix brand + search affordance"). Reuses the same
// PoisonMark mark component onboarding already renders (design.md's brand
// asset, not a reinterpretation) instead of duplicating the SVG. The search
// affordance links to `/search`; the real Search screen lands in Slice 5 -
// this is just the navigation target, per this slice's scope.
export function Header() {
  return (
    <header className="pf-header">
      <div className="pf-header__brand">
        <PoisonMark className="pf-header__mark" />
        <span className="pf-header__title">PoisonFlix</span>
      </div>

      <Link to="/search" className="pf-header__search" aria-label="Buscar">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </Link>
    </header>
  );
}
