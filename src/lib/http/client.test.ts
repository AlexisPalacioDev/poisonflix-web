import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './client';
import { ApiError, NetworkError } from './errors';
import { clearSession, getSession, setSession } from '../session/store';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('apiFetch', () => {
  beforeEach(() => {
    clearSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it('injects X-Emby-Token from the session store on jellyfin calls', async () => {
    setSession({ jellyfinToken: 'tok-123', jellyfinUserId: 'user-1', jellyseerrCookiePresent: false });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('jellyfin', '/Users/user-1/Items');

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get('X-Emby-Token')).toBe('tok-123');
  });

  it('does NOT inject X-Emby-Token when no session exists (e.g. authenticateByName)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('jellyfin', '/Users/AuthenticateByName');

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.has('X-Emby-Token')).toBe(false);
  });

  it('sends credentials: include on jellyseerr calls so connect.sid replays automatically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('jellyseerr', '/api/v1/search');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe('include');
  });

  it.each(['radarr', 'sonarr', 'prowlarr', 'bff'] as const)(
    'sends credentials: include on %s calls so the BFF can authenticate the caller via connect.sid',
    async (backend) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch(backend, '/api/v3/queue');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.credentials).toBe('include');
    },
  );

  it('clears the session and throws ApiError(401) on an unauthorized response, without retrying', async () => {
    setSession({ jellyfinToken: 'tok-expired', jellyfinUserId: 'user-1', jellyseerrCookiePresent: false });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('jellyfin', '/Users/user-1/Items')).rejects.toBeInstanceOf(ApiError);

    expect(getSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['radarr', 'sonarr', 'prowlarr'] as const)(
    'does NOT clear the session on a 401 from %s (proxy has no API key; must not log the user out)',
    async (backend) => {
      setSession({ jellyfinToken: 'tok-live', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);

      const err = await apiFetch(backend, '/api/v3/queue').catch((e) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(401);
      // The user's Jellyfin/Jellyseerr session must survive an unconfigured
      // *arr/indexer proxy 401 - otherwise the download-% poll logs them out.
      expect(getSession()).not.toBeNull();
    },
  );

  it('clears the session on a 403 from a jellyseerr GET (stale session -> re-login)', async () => {
    // A recreated/expired Jellyseerr rejects the old connect.sid with 403 (not
    // 401) on reads. Since every jellyseerr GET the SPA makes is a read any
    // authed user may perform, that 403 means the session died -> log out.
    setSession({ jellyfinToken: 'tok-stale', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 403, error: 'You do not have permission to access this endpoint' }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await apiFetch('jellyseerr', '/api/v1/search?query=x').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(getSession()).toBeNull();
  });

  it('does NOT clear the session on a 403 from a jellyseerr write (legit permission error)', async () => {
    // POST /request can legitimately 403 when the user lacks the REQUEST
    // permission - that must surface as an error, not log them out.
    setSession({ jellyfinToken: 'tok-live', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'forbidden' }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await apiFetch('jellyseerr', '/api/v1/request', { method: 'POST' }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(getSession()).not.toBeNull();
  });

  it('throws NetworkError when fetch itself rejects (connectivity/proxy failure)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('jellyfin', '/Users/AuthenticateByName')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws ApiError on a non-2xx, non-401 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'boom' }, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await apiFetch('jellyseerr', '/api/v1/search').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  it('resolves to undefined on a 204 No Content response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch('jellyfin', '/Sessions/Playing', { method: 'POST' });
    expect(result).toBeUndefined();
  });

  it('throws ApiError when the response fails schema validation instead of returning malformed data', async () => {
    const schema = z.object({ requiredField: z.string() });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ somethingElse: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('jellyfin', '/Users/user-1/Items', { schema })).rejects.toBeInstanceOf(ApiError);
  });

  it('returns schema-validated data on success', async () => {
    const schema = z.object({ requiredField: z.string() });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ requiredField: 'value' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch('jellyfin', '/Users/user-1/Items', { schema });
    expect(result).toEqual({ requiredField: 'value' });
  });
});
