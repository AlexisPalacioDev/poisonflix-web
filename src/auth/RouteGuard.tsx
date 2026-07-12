import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from './AuthContext';

// Redirects unauthenticated users to /onboarding (design.md §5/§7).
export function RouteGuard({ children }: { children: ReactNode }) {
  const { session } = useAuthContext();

  if (!session) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
