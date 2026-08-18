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

  // Remember which section of the app the user is in, so the next launch opens
  // where they left off. PoisonFlix is several products under one roof, and
  // someone who uses it as a music player — or as a console — was paying a
  // navigation tax on every single open.
  const section = sectionOf(location.pathname);
  useEffect(() => {
    if (section) rememberSection(section);
  }, [section]);

  // Applied once per page load, not on every visit to `/`. Otherwise cinema's
  // own home would be unreachable for anyone whose last section was another
  // one — the redirect would bounce them straight back out of it.
  //
  // "Any section that isn't cinema", not "music": cinema is the one whose home
  // IS `/`, so it is the only section for which landing here is already
  // correct. Testing for one named section instead would quietly make every
  // section added after it non-resumable.
  const landed = useRef(false);
  const resumeTo = lastSection();
  const shouldResume = !landed.current && location.pathname === '/' && resumeTo !== 'cine';
  landed.current = true;

  // Every hook runs before the redirect can return. Bailing out above them
  // made these two conditional, which is not a style rule: React matches hook
  // state by call order, so a render that skips them corrupts the state of
  // whatever hooks follow on the next one.
  //
  // Keeps the queue going once it runs out, from whichever screen built it.
  useAutoplayRadio();
  // Feeds Jellyfin the per-user listening history the recommendations read.
  useMusicScrobble();

  if (shouldResume) return <Navigate to={SECTION_HOME[resumeTo]} replace />;

  return (
    <>
      <Outlet />
      <NowPlayingBar />
    </>
  );
}
