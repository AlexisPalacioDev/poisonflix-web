// The running build's identity.
//
// `__PF_BUILD__` is replaced at build time by vite.config.ts. It exists
// because "are my changes even live?" was, for a whole night, unanswerable
// from the app itself — and the answer turned out to be no, twice, for two
// different reasons. A build id costs nothing and settles it from the couch.

declare const __PF_BUILD__: { commit: string; builtAt: string } | undefined;

export interface BuildStamp {
  commit: string;
  builtAt: string;
}

export function buildStamp(): BuildStamp {
  // `typeof` guard rather than a plain read: unit tests run through vitest,
  // which does not apply the production `define`.
  if (typeof __PF_BUILD__ === 'undefined') return { commit: 'dev', builtAt: 'dev' };
  return __PF_BUILD__;
}

/** Short, human-readable: `a1b2c3d · 7 ago 14:32`. */
export function buildLabel(): string {
  const { commit, builtAt } = buildStamp();
  if (builtAt === 'dev') return 'dev';
  const when = new Date(builtAt);
  if (Number.isNaN(when.getTime())) return commit;
  const stamp = when.toLocaleString('es', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${commit} · ${stamp}`;
}
