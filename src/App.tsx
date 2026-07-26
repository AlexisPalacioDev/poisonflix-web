import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { router as browserRouter } from './routes';
import { AuthProvider } from './auth/AuthContext';
import { MusicPlayerProvider } from './features/music/MusicPlayerProvider';

const queryClient = new QueryClient();

interface AppProps {
  // Injectable so tests can pass a `createMemoryRouter` instance instead of
  // exercising the real browser History/fetch APIs (unsupported under jsdom).
  router?: ReturnType<typeof createBrowserRouter>;
}

export function App({ router = browserRouter }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* Above the router so the single <audio> surface never unmounts on a
            route change — music keeps playing as the user browses. */}
        <MusicPlayerProvider>
          <RouterProvider router={router} />
        </MusicPlayerProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
