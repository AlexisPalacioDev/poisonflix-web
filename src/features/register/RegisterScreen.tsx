import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useRegister } from '../../hooks/useRegister';
import {
  validateInviteCode,
  validatePassword,
  validatePasswordConfirmation,
  validateUsername,
} from '../../lib/domain/registerValidation';
import { mapRegisterError } from './errorMessage';
import { PoisonMark } from '../onboarding/PoisonMark';
import '../onboarding/onboarding.css';
import './register.css';

// Public self-registration screen (register spec): an invited user turns
// their invite code into a Jellyfin/Jellyseerr account. Deliberately does
// NOT auto-login on success - the spec calls for landing back on the login
// screen so the two-phase Jellyfin+Jellyseerr auth in OnboardingScreen is the
// single place a session gets created, rather than duplicating that flow here.

interface FieldErrors {
  code?: string;
  username?: string;
  password?: string;
  confirmPassword?: string;
}

const REDIRECT_DELAY_MS = 1800;

export function RegisterScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Prefilled from an admin-generated invite link (`/register?code=...`),
  // but still a plain editable field - a user who typos the pasted code can
  // just fix it in place.
  const [code, setCode] = useState(() => searchParams.get('code') ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const registerMutation = useRegister();
  const isLoading = registerMutation.isPending;

  // A beat after success - long enough to read the confirmation, short
  // enough not to feel stuck - auto-redirect to login. The panel also has a
  // manual link for anyone who wants to go immediately.
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => navigate('/onboarding', { replace: true }), REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [success, navigate]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading || success) return;

    const errors: FieldErrors = {
      code: validateInviteCode(code) ?? undefined,
      username: validateUsername(username) ?? undefined,
      password: validatePassword(password) ?? undefined,
      confirmPassword: validatePasswordConfirmation(password, confirmPassword) ?? undefined,
    };
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) return;

    setGeneralError(null);
    registerMutation.mutate(
      { code: code.trim(), username: username.trim(), password },
      {
        onSuccess: () => setSuccess(true),
        onError: (err) => setGeneralError(mapRegisterError(err)),
      },
    );
  };

  if (success) {
    return (
      <main className="pf-onboarding">
        <div className="pf-onboarding__layout">
          <section className="pf-onboarding__brand">
            <PoisonMark className="pf-onboarding__mark" />
            <h1 className="pf-onboarding__title">PoisonFlix</h1>
            <p className="pf-onboarding__tagline">Tu Netflix propio, en un solo lugar.</p>
          </section>

          <div className="pf-onboarding__form-panel pf-register__success" role="status">
            <h2 className="pf-register__success-title">¡Cuenta creada!</h2>
            <p className="pf-register__success-message">
              Tu usuario <strong>{username}</strong> ya está listo. Te llevamos a iniciar sesión…
            </p>
            <Link to="/onboarding" className="pf-onboarding__submit pf-register__success-link">
              Iniciar sesión ahora
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="pf-onboarding">
      <div className="pf-onboarding__layout">
        <section className="pf-onboarding__brand">
          <PoisonMark className="pf-onboarding__mark" />
          <h1 className="pf-onboarding__title">PoisonFlix</h1>
          <p className="pf-onboarding__tagline">
            Creá tu cuenta con el código de invitación que te compartieron.
          </p>
        </section>

        <form className="pf-onboarding__form-panel" onSubmit={handleSubmit} noValidate>
          <div className="pf-onboarding__field">
            <label className="pf-onboarding__label" htmlFor="register-code">
              Código de invitación
            </label>
            <input
              id="register-code"
              className="pf-onboarding__input"
              type="text"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={isLoading}
            />
            {fieldErrors.code && (
              <p className="pf-register__field-error" role="alert">
                {fieldErrors.code}
              </p>
            )}
          </div>

          <div className="pf-onboarding__field">
            <label className="pf-onboarding__label" htmlFor="register-username">
              Usuario
            </label>
            <input
              id="register-username"
              className="pf-onboarding__input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isLoading}
            />
            {fieldErrors.username && (
              <p className="pf-register__field-error" role="alert">
                {fieldErrors.username}
              </p>
            )}
          </div>

          <div className="pf-onboarding__field">
            <label className="pf-onboarding__label" htmlFor="register-password">
              Contraseña
            </label>
            <input
              id="register-password"
              className="pf-onboarding__input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
            />
            {fieldErrors.password && (
              <p className="pf-register__field-error" role="alert">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="pf-onboarding__field">
            <label className="pf-onboarding__label" htmlFor="register-confirm-password">
              Repetir contraseña
            </label>
            <input
              id="register-confirm-password"
              className="pf-onboarding__input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={isLoading}
            />
            {fieldErrors.confirmPassword && (
              <p className="pf-register__field-error" role="alert">
                {fieldErrors.confirmPassword}
              </p>
            )}
          </div>

          {generalError && (
            <p className="pf-onboarding__error" role="alert">
              {generalError}
            </p>
          )}

          <button type="submit" className="pf-onboarding__submit" disabled={isLoading}>
            {isLoading ? 'Creando cuenta…' : 'Registrarse'}
          </button>

          <div className="pf-onboarding__links">
            <Link to="/onboarding" className="pf-onboarding__link">
              Ya tengo cuenta
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
