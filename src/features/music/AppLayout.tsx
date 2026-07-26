import { Outlet } from 'react-router-dom';
import { NowPlayingBar } from './NowPlayingBar';
import { useAutoplayRadio } from './useAutoplayRadio';
import { useMusicScrobble } from './useMusicScrobble';

// Pathless layout route wrapping the authed screens: renders the matched route
// via <Outlet/> plus the persistent NowPlayingBar underneath. The bar stays
// mounted across authed navigations (the layout itself never remounts), while
// the actual audio element lives one level higher in MusicPlayerProvider.
export function AppLayout() {
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
