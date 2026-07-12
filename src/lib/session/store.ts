// localStorage-backed session persistence, ported from `CredentialStore.kt`'s
// on-disk half. Unencrypted by design (ADR-5, accepted risk for a personal-LAN
// deployment) - the `connect.sid` value itself is NOT duplicated here; it
// stays in the browser's same-origin cookie jar and replays automatically via
// `credentials: 'include'`. Only a boolean marker that Jellyseerr auth
// succeeded is persisted.

const STORAGE_KEY = 'poisonflix:session';

export interface StoredSession {
  jellyfinToken: string;
  jellyfinUserId: string;
  /** ServerId from JellyfinAuthResponse - not currently required for any
   * request, kept so a future multi-server scenario doesn't need a re-login. */
  jellyfinServerId?: string;
  jellyseerrCookiePresent: boolean;
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
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
