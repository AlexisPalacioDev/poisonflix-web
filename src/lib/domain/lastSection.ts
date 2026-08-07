// Which half of the app you were last in.
//
// PoisonFlix is two products under one roof: cinema and Música. Reopening
// always in cinema means someone who uses it as a music player pays a
// navigation tax on every single launch, and the logo — the one control
// everyone presses to get "home" — took them out of the section they were
// working in rather than to the top of it.
//
// Deliberately a plain string in localStorage, like `musicPrefs`: it is a
// preference, not state, and losing it costs one tap.

const STORAGE_KEY = 'poisonflix:lastSection';

export type AppSection = 'cine' | 'musica';

/** Where the section's own home lives. */
export const SECTION_HOME: Record<AppSection, string> = {
  cine: '/',
  musica: '/musica',
};

/** Which section a path belongs to. Everything under /musica and /jam is the
 *  music half — a Jam is listening together, not a second product. */
export function sectionOf(pathname: string): AppSection | null {
  if (pathname === '/musica' || pathname.startsWith('/musica/')) return 'musica';
  if (pathname === '/jam' || pathname.startsWith('/jam/')) return 'musica';
  if (pathname === '/') return 'cine';
  // Everything else (a title page, downloads, admin) is shared furniture and
  // says nothing about which half the user considers themselves to be in.
  return null;
}

export function rememberSection(section: AppSection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, section);
  } catch {
    /* private mode — reopening in cinema is a small loss */
  }
}

export function lastSection(): AppSection {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'musica' ? 'musica' : 'cine';
  } catch {
    return 'cine';
  }
}
