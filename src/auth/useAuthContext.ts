import { createContext, useContext } from 'react';
import type { OnboardingCredentials } from '../lib/domain/onboardingAuth';
import type { Session } from './AuthContext';

// Split out of AuthContext.tsx so that module exports only its provider
// component: React Fast Refresh refuses to hot-reload a file that mixes
// components with anything else, and a full remount here drops the session
// state the whole app hangs off.

interface AuthContextValue {
  session: Session | null;
  /** Runs the two-phase onboarding auth (design.md §6) and, only on success,
   * persists + updates context state. Throws OnboardingAuthError on failure -
   * nothing is persisted in that case. */
  login: (credentials: OnboardingCredentials) => Promise<void>;
  /** Ends the session end-to-end: best-effort server-side Jellyseerr session
   * invalidation, then the local session clear. Async so callers can await the
   * teardown before redirecting, but it never rejects on a failed server call
   * (the local clear always runs) so a dead Jellyseerr session can't trap the
   * user. */
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return ctx;
}
