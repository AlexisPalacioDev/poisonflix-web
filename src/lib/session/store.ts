// localStorage-backed session persistence, ported from `CredentialStore.kt`'s
// on-disk half. Unencrypted by design (ADR-5, accepted risk for a personal-LAN
// deployment) - the `connect.sid` value itself is NOT duplicated here; it
// stays in the browser's same-origin cookie jar and replays automatically via
// `credentials: 'include'`. Only a boolean marker that Jellyseerr auth
// succeeded is persisted.

const STORAGE_KEY = 'poisonflix:session';

// Subscribers notified whenever the session is written or cleared. This is what
// lets AuthContext react to a session cleared OUT OF BAND - e.g. the http client
// clearing it on a 401 mid-session - so the route guard bounces to onboarding
// immediately instead of only on the next mount.
type SessionListener = (session: StoredSession | null) => void;
const listeners = new Set<SessionListener>();

export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(session: StoredSession | null): void {
  for (const listener of listeners) listener(session);
}

export interface StoredSession {
  jellyfinToken: string;
  jellyfinUserId: string;
  /** ServerId from JellyfinAuthResponse - not currently required for any
   * request, kept so a future multi-server scenario doesn't need a re-login. */
  jellyfinServerId?: string;
  jellyseerrCookiePresent: boolean;
  /** Derived from the Jellyseerr user's `permissions` bitmask (ADMIN = 2) at
   * login time - drives client-side gating of admin-only actions (e.g. the
   * library "Eliminar" flow). Optional (not `boolean`) so a session persisted
   * before this field existed still parses; treat a missing value as
   * non-admin (fail closed). The BFF re-enforces this server-side on every
   * write regardless, so this flag is a UX convenience, never the actual
   * authorization boundary. */
  isAdmin?: boolean;
}

export function getSession(): StoredSession | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function setSession(session: StoredSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  notify(session);
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
  notify(null);
}
