import { describe, expect, it } from 'vitest';
import { mapOnboardingError } from './errorMessage';
import { OnboardingAuthError } from '../../lib/domain/onboardingAuth';
import { ApiError, CorsError, NetworkError } from '../../lib/http/errors';

describe('mapOnboardingError', () => {
  it('maps a NetworkError/CorsError on jellyfin to a proxy/connectivity message', () => {
    const error = new OnboardingAuthError('jellyfin', new CorsError());
    expect(mapOnboardingError(error)).toMatch(/jellyfin/i);
    expect(mapOnboardingError(error)).toMatch(/proxy|conectar/i);
  });

  it('maps a NetworkError on jellyseerr to a proxy/connectivity message naming jellyseerr', () => {
    const error = new OnboardingAuthError('jellyseerr', new NetworkError());
    expect(mapOnboardingError(error)).toMatch(/jellyseerr/i);
  });

  it('maps ApiError(401) on jellyfin to an invalid-credentials message', () => {
    const error = new OnboardingAuthError('jellyfin', new ApiError(401, 'unauthorized'));
    expect(mapOnboardingError(error)).toMatch(/usuario o contraseña/i);
  });

  it('maps ApiError(401) on jellyseerr to a distinct message from a jellyfin 401', () => {
    const error = new OnboardingAuthError('jellyseerr', new ApiError(401, 'unauthorized'));
    const message = mapOnboardingError(error);
    expect(message).toMatch(/jellyseerr/i);
    expect(message).not.toBe(mapOnboardingError(new OnboardingAuthError('jellyfin', new ApiError(401, 'x'))));
  });

  it('falls back to a generic message for a non-auth error', () => {
    expect(mapOnboardingError(new Error('boom'))).toBe('Ocurrió un error inesperado. Intentá de nuevo.');
  });
});
