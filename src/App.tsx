import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { router as browserRouter } from './routes';
import { AuthProvider } from './auth/AuthContext';

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
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
