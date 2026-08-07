import { useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { SECTION_HOME, lastSection, rememberSection, sectionOf } from '../../lib/domain/lastSection';
import { NowPlayingBar } from './NowPlayingBar';
import { useAutoplayRadio } from './useAutoplayRadio';
import { useMusicScrobble } from './useMusicScrobble';

// Pathless layout route wrapping the authed screens: renders the matched route
// via <Outlet/> plus the persistent NowPlayingBar underneath. The bar stays
// mounted across authed navigations (the layout itself never remounts), while
// the actual audio element lives one level higher in MusicPlayerProvider.
export function AppLayout() {
  const location = useLocation();

  // Remember which half of the app the user is in, so the next launch opens
  // where they left off. PoisonFlix is two products under one roof, and
  // someone who uses it as a music player was paying a navigation tax on every
  // single open.
  const section = sectionOf(location.pathname);
  useEffect(() => {
    if (section) rememberSection(section);
  }, [section]);

  // Applied once per page load, not on every visit to `/`. Otherwise cinema's
  // own home would be unreachable for anyone whose last section was music —
  // the redirect would bounce them straight back out of it.
  const landed = useRef(false);
  const shouldResume = !landed.current && location.pathname === '/' && lastSection() === 'musica';
  landed.current = true;
  if (shouldResume) return <Navigate to={SECTION_HOME.musica} replace />;

  // Keeps the queue going once it runs out, from whichever screen built it.
  useAutoplayRadio();
  // Feeds Jellyfin the per-user listening history the recommendations read.
  useMusicScrobble();

  return (
    <>
      <Outlet />
      <NowPlayingBar />
    </>
  );
}
