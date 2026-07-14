import { Link } from 'react-router-dom';
import { PoisonMark } from '../onboarding/PoisonMark';
import '../onboarding/onboarding.css';
import './register.css';

// Public info screen (register spec): this deployment has no SMTP/email
// integration, so there is no self-service "reset link" flow - only an admin
// can reset a user's password (Admin screen's "Usuarios" section). This
// screen exists purely so /onboarding's "¿Olvidaste tu contraseña?" link has
// somewhere honest to go instead of a dead end.
export function ForgotPasswordScreen() {
  return (
    <main className="pf-onboarding">
      <div className="pf-onboarding__layout">
        <section className="pf-onboarding__brand">
          <PoisonMark className="pf-onboarding__mark" />
          <h1 className="pf-onboarding__title">PoisonFlix</h1>
          <p className="pf-onboarding__tagline">Tu Netflix propio, en un solo lugar.</p>
        </section>

        <div className="pf-onboarding__form-panel pf-register__success">
          <h2 className="pf-register__success-title">¿Olvidaste tu contraseña?</h2>
          <p className="pf-register__success-message">
            Todavía no hay recuperación automática por correo. Pedile a un administrador de PoisonFlix
            que te resetee la contraseña desde el panel de administración.
          </p>
          <Link to="/onboarding" className="pf-onboarding__submit pf-register__success-link">
            Volver a iniciar sesión
          </Link>
        </div>
      </div>
    </main>
  );
}
