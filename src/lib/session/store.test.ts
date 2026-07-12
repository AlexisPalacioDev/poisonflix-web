import { afterEach, describe, expect, it } from 'vitest';
import { clearSession, getSession, setSession, type StoredSession } from './store';

describe('session store', () => {
  afterEach(() => {
    clearSession();
  });

  it('returns null when nothing is persisted', () => {
    expect(getSession()).toBeNull();
  });

  it('round-trips a session through set/get', () => {
    const session: StoredSession = {
      jellyfinToken: 'token-abc',
      jellyfinUserId: 'user-1',
      jellyfinServerId: 'server-1',
      jellyseerrCookiePresent: true,
    };

    setSession(session);

    expect(getSession()).toEqual(session);
  });

  it('clears the persisted session', () => {
    setSession({ jellyfinToken: 't', jellyfinUserId: 'u', jellyseerrCookiePresent: false });
    clearSession();

    expect(getSession()).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', () => {
    localStorage.setItem('poisonflix:session', 'not-json{{');

    expect(getSession()).toBeNull();
  });
});
