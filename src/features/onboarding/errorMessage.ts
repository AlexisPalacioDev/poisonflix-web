import { isApiError, isNetworkError } from '../../lib/http/errors';
import { OnboardingAuthError } from '../../lib/domain/onboardingAuth';

// Maps the two-phase auth outcome to user-facing copy (onboarding spec's
// "Distinct error for proxy misconfiguration vs auth failure"). Kept as a
// pure function so the mapping is unit-testable without rendering the form.

const BACKEND_LABEL: Record<'jellyfin' | 'jellyseerr', string> = {
  jellyfin: 'Jellyfin',
  jellyseerr: 'Jellyseerr',
};

const BACKEND_PREFIX: Record<'jellyfin' | 'jellyseerr', string> = {
  jellyfin: '/jellyfin',
  jellyseerr: '/jellyseerr',
};

export function mapOnboardingError(error: unknown): string {
  if (!(error instanceof OnboardingAuthError)) {
    return 'Ocurrió un error inesperado. Intentá de nuevo.';
  }

  const backend = error.failedBackend;
  const label = BACKEND_LABEL[backend];
  const cause = error.cause;

  if (isNetworkError(cause)) {
    return `No se pudo conectar con ${label}. Revisá que el proxy (${BACKEND_PREFIX[backend]}) esté funcionando.`;
  }

  if (isApiError(cause) && cause.status === 401) {
    return backend === 'jellyfin'
      ? 'Usuario o contraseña incorrectos.'
      : 'Jellyfin conectó bien, pero Jellyseerr rechazó las credenciales.';
  }

  return `${label} rechazó la conexión. Intentá de nuevo.`;
}
