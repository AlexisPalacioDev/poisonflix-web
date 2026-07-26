import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthContext } from './useAuthContext';
import { authenticateBothBackends, type OnboardingCredentials } from '../lib/domain/onboardingAuth';
import { logout as jellyseerrLogout } from '../api/jellyseerr';
import { getOrCreateDeviceId } from '../lib/session/deviceId';
import { clearSession, getSession, setSession as persistSession, subscribeSession, type StoredSession } from '../lib/session/store';

// design.md §5 - Session store + AuthContext. Session shape is exactly the
// persisted shape (StoredSession); there is no separate in-memory model.
export type Session = StoredSession;

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

  const logout = async () => {
    // Best-effort: invalidate the server-side Jellyseerr session so the user
    // isn't left on a live `connect.sid` cookie. Swallow any failure - a
    // network error or a 401/403 from an already-dead session must NOT block
    // the local teardown below, otherwise a stale session would trap the user
    // on a screen with no way out (the bug this button closes).
    try {
      await jellyseerrLogout();
    } catch {
      // Intentionally ignored - local clear + redirect proceed regardless.
    }
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
