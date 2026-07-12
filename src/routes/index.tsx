import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { PublicOnlyRoute, RouteGuard } from '../auth/RouteGuard';
import { OnboardingScreen } from '../features/onboarding/OnboardingScreen';
import { HomeScreen } from '../features/home/HomeScreen';
import { SearchScreen } from '../features/search/SearchScreen';
import { DetailScreen } from '../features/detail/DetailScreen';
import { PlayerScreen } from '../features/player/PlayerScreen';

// Route tree per design.md §7. `:id` is the TMDB id for /detail and the
// Jellyfin item id for /player.
// Exported as a plain route object array (not just a bound `createBrowserRouter`
// instance) so tests can build a `createMemoryRouter` from the exact same
// tree instead of exercising real browser History/fetch APIs under jsdom.
export const routes: RouteObject[] = [
  {
    path: '/onboarding',
    element: (
      <PublicOnlyRoute>
        <OnboardingScreen />
      </PublicOnlyRoute>
    ),
  },
  {
    path: '/',
    element: (
      <RouteGuard>
        <HomeScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/search',
    element: (
      <RouteGuard>
        <SearchScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/detail/:id',
    element: (
      <RouteGuard>
        <DetailScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/player/:id',
    element: (
      <RouteGuard>
        <PlayerScreen />
      </RouteGuard>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
