import { createContext, useContext, useState, type ReactNode } from 'react';

// Slice 0 stub: shape only. Real two-phase login, session-store hydration,
// and logout side effects land in Slice 3 (design.md §5/§6).
export interface Session {
  jellyfinToken: string;
  jellyfinUserId: string;
  jellyseerrCookiePresent: boolean;
}

interface AuthContextValue {
  session: Session | null;
  login: (session: Session) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const login = (next: Session) => setSession(next);
  const logout = () => setSession(null);

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
