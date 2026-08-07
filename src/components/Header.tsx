import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AdultPinOverlay } from './AdultPinOverlay';
import { OverlayShell } from './overlay/OverlayShell';
import { PoisonMark } from '../features/onboarding/PoisonMark';
import { useAdultUnlocked } from '../hooks/useAdultUnlocked';
import { useAuth } from '../hooks/useAuth';
import { useLanguage } from '../hooks/useLanguage';
import { useMediaQuery } from '../hooks/useMediaQuery';
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
  const location = useLocation();
  const { session, logout } = useAuth();
  const isAdmin = session?.isAdmin === true;

  // Whether we're inside the music section. When true the "Música" control
  // flips into a "back to movies/series" (Netflix mode) affordance so the user
  // always has a way out of /musica* - the button they were missing.
  const inMusic = location.pathname === '/musica' || location.pathname.startsWith('/musica/');

  // Below the now-playing bar's breakpoint (899px) the row of nav controls no
  // longer fits, so they collapse behind a hamburger menu. Reuses the shared
  // `useMediaQuery` hook for a single source of truth on that breakpoint.
  const isMobile = useMediaQuery('(max-width: 899px)');
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Anchor for the portalled dropdown panel (see the OverlayShell import
  // below) - `.pf-header` is `position: fixed`, its own stacking context, so
  // the panel can no longer rely on a local `position: relative` ancestor
  // once it's portalled away from this subtree.
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // Growing to the desktop width auto-closes the menu so its dropdown never
  // lingers over the now-inline row.
  useEffect(() => {
    if (!isMobile) setMenuOpen(false);
  }, [isMobile]);

  // Dismissal (outside click, Escape, returning focus to the toggle, and
  // locking body scroll while open) is owned by the shared `OverlayShell`
  // (design D: `sdd/mobile-music-overhaul`) rather than a bare
  // `document.addEventListener('mousedown')` with no backdrop node - that
  // pattern is the one suspected of failing on iOS Safari, where a tap on
  // "non-clickable" background can skip `mousedown` entirely.
  //
  // The panel is portalled TOGETHER with the backdrop (via `anchorRef`),
  // not rendered as a separate local sibling: `.pf-header` is
  // `position: fixed`, so it always creates its own stacking context. A
  // panel left in place would stay trapped inside that context while a
  // backdrop portalled alone to `document.body` escaped to the root one -
  // same z-index there, and the backdrop (later in that context's document
  // order) painted OVER the whole panel. Every tap on a menu item hit the
  // backdrop instead and just closed the menu without navigating (real-
  // Chrome audit finding; jsdom's hit-testing-free event dispatch could not
  // catch it). See `OverlayShell`'s module doc comment for the general fix.
  const closeMenu = () => setMenuOpen(false);

  // Move focus into the panel when it opens so keyboard / D-pad users land on
  // the first item instead of being stranded on the toggle.
  useEffect(() => {
    if (!menuOpen) return;
    const first = panelRef.current?.querySelector<HTMLElement>('a, button');
    first?.focus();
  }, [menuOpen]);

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

  const handleLogout = async () => {
    // logout() never rejects (best-effort server invalidation + local clear),
    // so the redirect always runs. Explicit navigate rather than leaning on
    // RouteGuard's reactive bounce so logout works from any header context.
    await logout();
    navigate('/onboarding', { replace: true });
  };

  const handleAdultPinClose = () => {
    setPinOpen(false);
    // Cancelled (Escape / backdrop) without unlocking: drop the pending nav so
    // a later unlock elsewhere never yanks the user to the +18 screen.
    if (!isAdultUnlocked()) pendingAdultNav.current = false;
  };

  // Every nav control, rendered once so the desktop inline row and the mobile
  // hamburger dropdown stay in perfect sync. `onSelect` fires after each action
  // so picking an item from the mobile menu closes it; on desktop it's omitted.
  const renderControls = (onSelect?: () => void) => (
    <>
      <button
        type="button"
        className="pf-header__search pf-header__lang-chip"
        aria-label="Cambiar idioma"
        onClick={() => {
          handleToggleLanguage();
          onSelect?.();
        }}
      >
        <span className="pf-header__search-label">{language === 'es' ? 'ES' : 'EN'}</span>
      </button>

      <Link to="/search" className="pf-header__search" aria-label="Buscar" onClick={onSelect}>
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
        onClick={() => {
          handleAdultClick();
          onSelect?.();
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span className="pf-header__search-label">+18</span>
      </button>

      {inMusic ? (
        // In the music section: flip to a "back to movies/series" (Netflix mode)
        // affordance - a film-strip glyph that returns to the main home route.
        <button
          type="button"
          className="pf-header__search"
          aria-label="Volver a películas y series"
          onClick={() => {
            navigate('/');
            onSelect?.();
          }}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"
            />
          </svg>
          <span className="pf-header__search-label">Películas y series</span>
        </button>
      ) : (
        <Link to="/musica" className="pf-header__search" aria-label="Música" onClick={onSelect}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 18V5l12-2v13"
            />
            <circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="pf-header__search-label">Música</span>
        </Link>
      )}

      <Link to="/downloads" className="pf-header__search" aria-label="Descargas" onClick={onSelect}>
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

      <Link to="/jam" className="pf-header__search" aria-label="Jam" onClick={onSelect}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="7" cy="17" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="17" cy="17" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 17V5l10-2v14"
          />
        </svg>
        <span className="pf-header__search-label">Jam</span>
      </Link>

      {isAdmin && (
        <Link to="/admin" className="pf-header__search" aria-label="Admin" onClick={onSelect}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            />
          </svg>
          <span className="pf-header__search-label">Admin</span>
        </Link>
      )}

      <button
        type="button"
        className="pf-header__search"
        aria-label="Cerrar sesión"
        onClick={() => {
          handleLogout();
          onSelect?.();
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12H3m0 0l4-4m-4 4l4 4M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"
          />
        </svg>
        <span className="pf-header__search-label">Cerrar sesión</span>
      </button>
    </>
  );

  return (
    <header
      className={`pf-header${scrolled ? ' pf-header--scrolled' : ''}${inMusic ? ' pf-header--music' : ''}`}
    >
      <Link to="/" className="pf-header__brand" aria-label="PoisonFlix - Inicio">
        <PoisonMark className="pf-header__mark" variant={inMusic ? 'music' : 'default'} />
        <span className="pf-header__title">{inMusic ? 'PoisonFy' : 'PoisonFlix'}</span>
      </Link>

      {isMobile ? (
        <div className="pf-header__menu">
          <button
            ref={hamburgerRef}
            type="button"
            className="pf-header__search pf-header__hamburger"
            aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="pf-header-menu-panel"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                d="M4 7h16M4 12h16M4 17h16"
              />
            </svg>
          </button>

          {menuOpen && (
            <OverlayShell
              variant="menu"
              onDismiss={closeMenu}
              className="pf-header__menu-backdrop"
              ariaLabel="Cerrar menú (fondo)"
              anchorRef={hamburgerRef}
            >
              <div
                id="pf-header-menu-panel"
                ref={panelRef}
                className="pf-header__menu-panel"
                role="menu"
                aria-label="Menú de navegación"
              >
                {renderControls(() => setMenuOpen(false))}
              </div>
            </OverlayShell>
          )}
        </div>
      ) : (
        <div className="pf-header__actions">{renderControls()}</div>
      )}

      <AdultPinOverlay open={pinOpen} onClose={handleAdultPinClose} />
    </header>
  );
}
