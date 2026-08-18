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
import { RegisterScreen } from '../features/register/RegisterScreen';
import { ForgotPasswordScreen } from '../features/register/ForgotPasswordScreen';
import { AdminScreen } from '../features/admin/AdminScreen';
import { AppLayout } from '../features/music/AppLayout';
import { RemoteScreen } from '../features/remote/RemoteScreen';
import { MusicScreen } from '../features/music/MusicScreen';
import { DownloadedScreen } from '../features/music/DownloadedScreen';
import { AlbumScreen } from '../features/music/AlbumScreen';
import { ArtistScreen } from '../features/music/ArtistScreen';
import { TrackScreen } from '../features/music/TrackScreen';
import { PlaylistScreen } from '../features/music/PlaylistScreen';
import { JamScreen } from '../features/jam/JamScreen';
import { GamesScreen } from '../features/games/GamesScreen';
import { GamePlayerScreen } from '../features/games/GamePlayerScreen';
import { CastScreen } from '../features/cast/CastScreen';

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
    // `/cast/:id` - the one route with NEITHER guard, and the only one outside
    // `AppLayout`. A television opening a cast URL has no session (ours lives
    // in the phone's localStorage), so `RouteGuard` would bounce it to the
    // login screen while the app reported "Reproduciendo en LG del living".
    // It carries its own credential in the query string instead - see
    // `features/cast/CastScreen.tsx` for the trade-off, and for why that
    // screen is a bare playback surface with no way to reach anything else.
    // Outside `AppLayout` on purpose too: that layout pins the music bar and
    // the section-resume redirect, both of which are app navigation.
    path: '/cast/:id',
    element: <CastScreen />,
  },
  {
    // Pathless layout route: every authed screen renders inside AppLayout, which
    // pins the persistent NowPlayingBar under the routed content. The bar stays
    // mounted across authed navigations (the layout never remounts); the audio
    // element itself lives higher still, in MusicPlayerProvider (App.tsx).
    element: <AppLayout />,
    children: [
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
  {
    // Phone-as-remote: a D-pad plus, crucially, a text field, because typing a
    // music search on the projector's on-screen keyboard is miserable. Relayed
    // through the BFF to a listener inside the app on the projector.
    path: '/control',
    element: (
      <RouteGuard>
        <RemoteScreen />
      </RouteGuard>
    ),
  },
  {
    // Música (Slice 1): search YouTube Music, download to the server, play from
    // the Jellyfin library through the persistent bar.
    path: '/musica',
    element: (
      <RouteGuard>
        <MusicScreen />
      </RouteGuard>
    ),
  },
  {
    // "Tu música descargada": the songs actually on the server. Its own page,
    // not the "Canciones" tab it used to be — the owner's library was filed
    // among the browse facets as if it were another playlist.
    path: '/musica/descargas',
    element: (
      <RouteGuard>
        <DownloadedScreen />
      </RouteGuard>
    ),
  },
  {
    // Música browse (Slice 3): album detail — header + track list, play the
    // whole album or single tracks through the persistent bar.
    path: '/musica/album/:id',
    element: (
      <RouteGuard>
        <AlbumScreen />
      </RouteGuard>
    ),
  },
  {
    // Música browse (Slice 3): artist detail — the artist's albums, each
    // linking to its album page.
    path: '/musica/artist/:id',
    element: (
      <RouteGuard>
        <ArtistScreen />
      </RouteGuard>
    ),
  },
  {
    // Música track detail: a single song's full info, with cross-links to its
    // artist and album pages. Reached by clicking a song row/title/cover.
    path: '/musica/track/:id',
    element: (
      <RouteGuard>
        <TrackScreen />
      </RouteGuard>
    ),
  },
  {
    // Música playlists: one user-created playlist's tracks — play the whole
    // list, remove single tracks, or delete the list.
    path: '/musica/playlist/:id',
    element: (
      <RouteGuard>
        <PlaylistScreen />
      </RouteGuard>
    ),
  },
  {
    // Juegos: the ROM library the server exposes, grouped by console.
    path: '/juegos',
    element: (
      <RouteGuard>
        <GamesScreen />
      </RouteGuard>
    ),
  },
  {
    // The emulator itself, full screen. `:id` is the ROM id from the library —
    // the console it needs is looked up there, not carried in the URL.
    path: '/juegos/play/:id',
    element: (
      <RouteGuard>
        <GamePlayerScreen />
      </RouteGuard>
    ),
  },
  {
    // Jam: collaborative listening — list/create/join rooms, transport
    // controls gated by `canControlTransport` (lib/domain/jam.ts).
    path: '/jam',
    element: (
      <RouteGuard>
        <JamScreen />
      </RouteGuard>
    ),
  },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
