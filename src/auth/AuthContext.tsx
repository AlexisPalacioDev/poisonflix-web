import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authenticateBothBackends, type OnboardingCredentials } from '../lib/domain/onboardingAuth';
import { getOrCreateDeviceId } from '../lib/session/deviceId';
import { clearSession, getSession, setSession as persistSession, subscribeSession, type StoredSession } from '../lib/session/store';

// design.md §5 - Session store + AuthContext. Session shape is exactly the
// persisted shape (StoredSession); there is no separate in-memory model.
export type Session = StoredSession;

interface AuthContextValue {
  session: Session | null;
  /** Runs the two-phase onboarding auth (design.md §6) and, only on success,
   * persists + updates context state. Throws OnboardingAuthError on failure -
   * nothing is persisted in that case. */
  login: (credentials: OnboardingCredentials) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Hydrate from localStorage on boot so a reload routes straight to Home
  // instead of bouncing back through onboarding (onboarding spec: session
  // persists across reload).
  const [session, setSessionState] = useState<Session | null>(() => getSession());
  const queryClient = useQueryClient();

  // React to session writes/clears that happen outside login()/logout() - most
  // importantly the http client calling clearSession() on a 401. Without this,
  // localStorage would be cleared but this state would keep the stale session,
  // so RouteGuard wouldn't bounce to onboarding until the next mount.
  useEffect(() => {
    return subscribeSession((next) => {
      setSessionState(next);
      if (!next) queryClient.clear();
    });
  }, [queryClient]);

  const login = async (credentials: OnboardingCredentials) => {
    const deviceId = getOrCreateDeviceId();
    const next = await authenticateBothBackends(credentials, deviceId);
    persistSession(next);
    setSessionState(next);
  };

  const logout = () => {
    clearSession();
    setSessionState(null);
    queryClient.clear();
  };

  return (
    <AuthContext.Provider value={{ session, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return ctx;
}
