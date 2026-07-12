import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../auth/AuthContext';
import { mapOnboardingError } from './errorMessage';
import { PoisonMark } from './PoisonMark';
import './onboarding.css';

// Two-panel onboarding/login (design.md §6, ← OnboardingScreen.kt). Unlike
// the native app - which hits absolute IPs and so needs 4 fields (Jellyfin
// URL, Jellyseerr URL, user, pass) - this web app is same-origin via the
// reverse proxy: the backend base URLs are the fixed proxy prefixes
// (`/jellyfin`, `/jellyseerr`, lib/http/client.ts's BASE_URLS), not
// user-entered. The form only requires username + password; the fixed
// prefixes are shown read-only under an optional "advanced" disclosure so
// the two-panel/four-field spirit of the spec is preserved without asking
// the user to type infrastructure details they can't change.
const JELLYFIN_BASE = import.meta.env.VITE_JELLYFIN_BASE ?? '/jellyfin';
const JELLYSEERR_BASE = import.meta.env.VITE_JELLYSEERR_BASE ?? '/jellyseerr';

export function OnboardingScreen() {
  const { login } = useAuthContext();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading) return;

    if (!username.trim() || !password) {
      setErrorMessage('Completá usuario y contraseña.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      await login({ username, password });
      navigate('/', { replace: true });
    } catch (err) {
      setErrorMessage(mapOnboardingError(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="pf-onboarding">
      <div className="pf-onboarding__layout">
        <section className="pf-onboarding__brand">
          <PoisonMark className="pf-onboarding__mark" />
          <h1 className="pf-onboarding__title">PoisonFlix</h1>
          <p className="pf-onboarding__tagline">
            Tu Netflix propio, en un solo lugar. Busca, pide y mira todo desde aquí.
          </p>
        </section>

        <form className="pf-onboarding__form-panel" onSubmit={handleSubmit} noValidate>
          <div className="pf-onboarding__field">
            <label className="pf-onboarding__label" htmlFor="onboarding-username">
              Usuario
            </label>
            <input
              id="onboarding-username"
              className="pf-onboarding__input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div className="pf-onboarding__field">
            <label className="pf-onboarding__label" htmlFor="onboarding-password">
              Contraseña
            </label>
            <input
              id="onboarding-password"
              className="pf-onboarding__input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
            />
          </div>

          {errorMessage && (
            <p className="pf-onboarding__error" role="alert">
              {errorMessage}
            </p>
          )}

          <button type="submit" className="pf-onboarding__submit" disabled={isLoading}>
            {isLoading ? 'Conectando…' : 'Conectar'}
          </button>

          <details className="pf-onboarding__advanced">
            <summary>Configuración avanzada</summary>
            <div className="pf-onboarding__advanced-row">
              <span>Jellyfin</span>
              <code>{JELLYFIN_BASE}</code>
            </div>
            <div className="pf-onboarding__advanced-row">
              <span>Jellyseerr</span>
              <code>{JELLYSEERR_BASE}</code>
            </div>
          </details>
        </form>
      </div>
    </main>
  );
}
