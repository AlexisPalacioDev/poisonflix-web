import { Outlet } from 'react-router-dom';
import { NowPlayingBar } from './NowPlayingBar';

// Pathless layout route wrapping the authed screens: renders the matched route
// via <Outlet/> plus the persistent NowPlayingBar underneath. The bar stays
// mounted across authed navigations (the layout itself never remounts), while
// the actual audio element lives one level higher in MusicPlayerProvider.
export function AppLayout() {
  return (
    <>
      <Outlet />
      <NowPlayingBar />
    </>
  );
}
