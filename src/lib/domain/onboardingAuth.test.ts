import { describe, expect, it, vi, beforeEach } from 'vitest';
import { authenticateBothBackends, OnboardingAuthError } from './onboardingAuth';
import { authenticateByName } from '../../api/jellyfin';
import { authJellyfin } from '../../api/jellyseerr';
import { ApiError } from '../http/errors';

vi.mock('../../api/jellyfin', () => ({ authenticateByName: vi.fn() }));
vi.mock('../../api/jellyseerr', () => ({ authJellyfin: vi.fn() }));

const mockedAuthenticateByName = vi.mocked(authenticateByName);
const mockedAuthJellyfin = vi.mocked(authJellyfin);

const CREDENTIALS = { username: 'perroenvenenado', password: 'pass1234' };
const DEVICE_ID = 'device-1';

describe('authenticateBothBackends', () => {
  beforeEach(() => {
    mockedAuthenticateByName.mockReset();
    mockedAuthJellyfin.mockReset();
  });

  it('happy path: both succeed and the session is built from the Jellyfin response', async () => {
    mockedAuthenticateByName.mockResolvedValue({
      User: { Id: 'user-1', Name: 'perroenvenenado' },
      AccessToken: 'token-abc',
      ServerId: 'server-1',
    });
    mockedAuthJellyfin.mockResolvedValue({ id: 1, email: null, username: 'perroenvenenado' } as never);

    const session = await authenticateBothBackends(CREDENTIALS, DEVICE_ID);

    expect(session).toEqual({
      jellyfinToken: 'token-abc',
      jellyfinUserId: 'user-1',
      jellyfinServerId: 'server-1',
      jellyseerrCookiePresent: true,
    });
    expect(mockedAuthenticateByName).toHaveBeenCalledWith({ ...CREDENTIALS, deviceId: DEVICE_ID });
    expect(mockedAuthJellyfin).toHaveBeenCalledWith(CREDENTIALS);
  });

  it('Jellyfin fails: stops before calling Jellyseerr, throws OnboardingAuthError(jellyfin)', async () => {
    const cause = new ApiError(401, 'bad credentials');
    mockedAuthenticateByName.mockRejectedValue(cause);

    await expect(authenticateBothBackends(CREDENTIALS, DEVICE_ID)).rejects.toMatchObject({
      failedBackend: 'jellyfin',
      cause,
    });
    expect(mockedAuthJellyfin).not.toHaveBeenCalled();
  });

  it('Jellyfin succeeds, Jellyseerr fails: discards the Jellyfin token, throws OnboardingAuthError(jellyseerr)', async () => {
    mockedAuthenticateByName.mockResolvedValue({
      User: { Id: 'user-1', Name: 'perroenvenenado' },
      AccessToken: 'token-abc',
      ServerId: 'server-1',
    });
    const cause = new ApiError(401, 'jellyseerr rejected');
    mockedAuthJellyfin.mockRejectedValue(cause);

    let thrown: unknown;
    try {
      await authenticateBothBackends(CREDENTIALS, DEVICE_ID);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(OnboardingAuthError);
    expect((thrown as OnboardingAuthError).failedBackend).toBe('jellyseerr');
    expect((thrown as OnboardingAuthError).cause).toBe(cause);
    // Nothing is returned/persisted on this branch - the caller never
    // receives a session object to hand to the session store.
  });
});
