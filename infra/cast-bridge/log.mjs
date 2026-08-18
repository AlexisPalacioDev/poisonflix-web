// One-line JSON logging, the same shape the BFF emits (see `logError` in
// infra/bff/server.mjs) so `docker compose logs` reads the same across services.
//
// It lives in its own module rather than in server.mjs because server.mjs binds
// a socket at import time: every other file here would have to start a listener
// just to log a line, and `node --test` would inherit it. games.mjs solves the
// same problem by duplicating the function; there are five modules here, so one
// side-effect-free module is cheaper than five copies that can drift apart.

function emit(level, scope, message, detail) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    scope,
    message,
    ...detail,
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export function logError(scope, err, detail = {}) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  emit('error', scope, message, detail);
}

/**
 * Deliberately used for things that SUCCEEDED but say something about the LAN:
 * how many devices a scan saw, which protocol a play went out on. A discovery
 * service that only logs failures cannot answer "did it even look?", which is
 * the first question when the list comes back empty.
 */
export function logInfo(scope, message, detail = {}) {
  emit('info', scope, message, detail);
}
