import { useCallback, useEffect, useRef, useState } from 'react';
import { pingProjector, sendKey, sendText, type RemoteKey } from '../../api/remote';
import './remote.css';

/**
 * The phone as the projector's remote.
 *
 * The reason this exists is typing: a D-pad keyboard makes searching for music
 * genuinely unpleasant, and the phone already has a real keyboard. Everything
 * else — the D-pad, transport, back — is here because once you are holding the
 * phone you should not have to reach for the other remote.
 *
 * ## Why the text field submits instead of streaming keystrokes
 * Each character would otherwise be a round trip through the relay, and typing
 * would feel laggy and could arrive out of order. One request per submit is
 * instant and atomic; the projector expands it into real key events on its side.
 */
export function RemoteScreen() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await pingProjector();
      if (!cancelled) setOnline(ok);
    };
    check();
    // The projector sleeps and the app gets closed; a slow poll keeps the
    // status honest without hammering the relay.
    const timer = window.setInterval(check, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const press = useCallback(async (key: RemoteKey) => {
    // Haptic tap where the platform offers it: without it a remote with no
    // travel gives no sign a press registered.
    navigator.vibrate?.(10);
    try {
      await sendKey(key);
      setOnline(true);
    } catch {
      setOnline(false);
      setNotice('No se pudo alcanzar el proyector');
    }
  }, []);

  const submitText = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await sendText(value);
      setText('');
      setNotice(`Enviado: ${value}`);
      // Keep focus so the next query can be typed without tapping again.
      inputRef.current?.focus();
    } catch {
      setOnline(false);
      setNotice('No se pudo alcanzar el proyector');
    } finally {
      setBusy(false);
    }
  }, [text, busy]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div className="remote">
      <header className="remote__header">
        <h1>Control</h1>
        <span
          className={`remote__status remote__status--${online === null ? 'unknown' : online ? 'on' : 'off'}`}
        >
          {online === null ? 'Buscando…' : online ? 'Proyector conectado' : 'Sin conexión'}
        </span>
      </header>

      <form
        className="remote__type"
        onSubmit={(event) => {
          event.preventDefault();
          submitText();
        }}
      >
        <input
          ref={inputRef}
          className="remote__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Escribí y enviá al proyector"
          // Explicit so phone keyboards show a send key rather than a newline.
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Texto para enviar al proyector"
        />
        <button className="remote__send" type="submit" disabled={!text.trim() || busy}>
          Enviar
        </button>
      </form>

      <div className="remote__pad">
        <button className="remote__key remote__key--up" onClick={() => press('DPAD_UP')} aria-label="Arriba">▲</button>
        <button className="remote__key remote__key--left" onClick={() => press('DPAD_LEFT')} aria-label="Izquierda">◀</button>
        <button className="remote__key remote__key--ok" onClick={() => press('DPAD_CENTER')} aria-label="Aceptar">OK</button>
        <button className="remote__key remote__key--right" onClick={() => press('DPAD_RIGHT')} aria-label="Derecha">▶</button>
        <button className="remote__key remote__key--down" onClick={() => press('DPAD_DOWN')} aria-label="Abajo">▼</button>
      </div>

      <div className="remote__row">
        <button className="remote__aux" onClick={() => press('BACK')}>Atrás</button>
        <button className="remote__aux" onClick={() => press('DEL')}>Borrar</button>
        <button className="remote__aux" onClick={() => press('HOME')}>Inicio</button>
      </div>

      <div className="remote__row">
        <button className="remote__aux" onClick={() => press('MEDIA_PREVIOUS')} aria-label="Anterior">⏮</button>
        <button className="remote__aux" onClick={() => press('MEDIA_PLAY_PAUSE')} aria-label="Reproducir o pausar">⏯</button>
        <button className="remote__aux" onClick={() => press('MEDIA_NEXT')} aria-label="Siguiente">⏭</button>
      </div>

      <div className="remote__row">
        <button className="remote__aux" onClick={() => press('VOLUME_DOWN')} aria-label="Bajar volumen">Vol −</button>
        <button className="remote__aux" onClick={() => press('VOLUME_UP')} aria-label="Subir volumen">Vol +</button>
      </div>

      {notice && <p className="remote__notice">{notice}</p>}
    </div>
  );
}
