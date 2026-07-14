import { isApiError, isNetworkError } from '../../lib/http/errors';

// Maps the BFF's register/reset-password error codes to Spanish copy
// (backend contract: infra/bff, not owned/changed by this frontend). Kept as
// pure functions, mirroring onboarding's `errorMessage.ts` pattern.

interface BffErrorBody {
  error?: string;
  message?: string;
}

function bffErrorCode(error: unknown): BffErrorBody | undefined {
  if (!isApiError(error)) return undefined;
  const body = error.body;
  if (body && typeof body === 'object' && 'error' in body) {
    return body as BffErrorBody;
  }
  return undefined;
}

const REGISTER_ERROR_MESSAGES: Record<string, string> = {
  invite_not_found: 'El código de invitación no existe.',
  invite_used: 'Este código ya fue usado.',
  invite_expired: 'El código expiró.',
  username_taken: 'Ese usuario ya existe.',
  too_many_requests: 'Demasiados intentos, probá más tarde.',
  jellyfin_unreachable: 'No se pudo completar el registro, intentá de nuevo.',
  jellyfin_create_failed: 'No se pudo completar el registro, intentá de nuevo.',
  jellyseerr_import_failed: 'No se pudo completar el registro, intentá de nuevo.',
};

export function mapRegisterError(error: unknown): string {
  if (isNetworkError(error)) {
    return 'No se pudo conectar con el servidor. Revisá tu conexión e intentá de nuevo.';
  }

  const body = bffErrorCode(error);
  const code = body?.error;

  if (code?.startsWith('invalid_')) {
    return body?.message ?? 'Revisá los datos ingresados.';
  }
  if (code && code in REGISTER_ERROR_MESSAGES) {
    return REGISTER_ERROR_MESSAGES[code];
  }

  return 'Ocurrió un error inesperado. Intentá de nuevo.';
}

export function mapResetPasswordError(error: unknown): string {
  if (isNetworkError(error)) {
    return 'No se pudo conectar con el servidor. Revisá tu conexión e intentá de nuevo.';
  }

  const body = bffErrorCode(error);
  if (body?.error === 'invalid_password') {
    return body.message ?? 'La contraseña no es válida.';
  }

  return 'No se pudo actualizar la contraseña. Intentá de nuevo.';
}
