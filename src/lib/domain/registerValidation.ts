// Client-side mirrors of the BFF's `POST /bff/register` validation, so
// obviously-invalid input never leaves the browser. Kept as pure functions -
// testable without rendering RegisterScreen, and reused by AdminScreen's
// reset-password form (`validatePassword`).

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

export function validateInviteCode(code: string): string | null {
  return code.trim() === '' ? 'Ingresá el código de invitación.' : null;
}

export function validateUsername(username: string): string | null {
  if (username.trim() === '') return 'Ingresá un usuario.';
  return USERNAME_RE.test(username)
    ? null
    : 'El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.';
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return 'La contraseña es demasiado larga.';
  }
  return null;
}

export function validatePasswordConfirmation(password: string, confirmPassword: string): string | null {
  return password === confirmPassword ? null : 'Las contraseñas no coinciden.';
}
