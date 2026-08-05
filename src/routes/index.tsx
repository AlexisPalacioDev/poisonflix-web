import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { PublicOnlyRoute, RouteGuard } from '../auth/RouteGuard';
import { OnboardingScreen } from '../features/onboarding/OnboardingScreen';
import { HomeScreen } from '../features/home/HomeScreen';
import { SearchScreen } from '../features/search/SearchScreen';
import { AdultSearchScreen } from '../features/search/AdultSearchScreen';
import { DetailScreen } from '../features/detail/DetailScreen';
import { PlayerScreen } from '../features/player/PlayerScreen';
import { DownloadsScreen } from '../features/downloads/DownloadsScreen';
import { CategoryScreen } from '../features/browse/CategoryScreen';
import { LibraryScreen } from '../features/browse/LibraryScreen';
import { TrendingScreen } from '../features/browse/TrendingScreen';
import { ContinueWatchingScreen } from '../features/browse/ContinueWatchingScreen';
import { FavoritesScreen } from '../features/browse/FavoritesScreen';
import { WatchlistScreen } from '../features/browse/WatchlistScreen';
import { RegisterScreen } from '../features/register/RegisterScreen';
import { ForgotPasswordScreen } from '../features/register/ForgotPasswordScreen';
import { AdminScreen } from '../features/admin/AdminScreen';

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
    // Invite-based self-registration (register spec) - public, same guard as
    // /onboarding so an already-logged-in user skips straight to Home.
    path: '/register',
    element: (
      <PublicOnlyRoute>
        <RegisterScreen />
      </PublicOnlyRoute>
    ),
  },
  {
    path: '/forgot-password',
    element: (
      <PublicOnlyRoute>
        <ForgotPasswordScreen />
      </PublicOnlyRoute>
    ),
  },
  {
    // RouteGuard only guarantees a session exists; the isAdmin gate itself
    // lives inside AdminScreen (mirrors Downloads' admin-only +18 delete).
    path: '/admin',
    element: (
      <RouteGuard>
        <AdminScreen />
      </RouteGuard>
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
    // "Ver todo" grids reached from each Home row's title (Row `titleTo`).
    // `/category/:id` is one of NORMAL_CATEGORIES ids (action, comedy, …);
    // library/trending/resume mirror the three non-genre Home rows. "En camino"
    // has no route here - its title reuses the existing `/downloads` screen.
    path: '/category/:id',
    element: (
      <RouteGuard>
        <CategoryScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/library',
    element: (
      <RouteGuard>
        <LibraryScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/trending',
    element: (
      <RouteGuard>
        <TrendingScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/resume',
    element: (
      <RouteGuard>
        <ContinueWatchingScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/favorites',
    element: (
      <RouteGuard>
        <FavoritesScreen />
      </RouteGuard>
    ),
  },
  {
    path: '/watchlist',
    element: (
      <RouteGuard>
        <WatchlistScreen />
      </RouteGuard>
    ),
  },
  {
    // +18 search mode (projector-feature-map.md §6/§7, walkthrough's
    // `onNavigateToAdultSearch -> navigate("search_adult")`).
    path: '/search_adult',
    element: (
      <RouteGuard>
        <AdultSearchScreen />
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
  {
    path: '/downloads',
    element: (
      <RouteGuard>
        <DownloadsScreen />
      </RouteGuard>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
