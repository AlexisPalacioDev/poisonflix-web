// Which part of the app you were last in.
//
// PoisonFlix is several products under one roof: cinema, Música and Juegos.
// Reopening always in cinema means someone who uses it as a music player pays a
// navigation tax on every single launch, and the logo — the one control
// everyone presses to get "home" — took them out of the section they were
// working in rather than to the top of it.
//
// Deliberately a plain string in localStorage, like `musicPrefs`: it is a
// preference, not state, and losing it costs one tap.
//
// The section list is data, not control flow. It used to be a pair of literals
// spread across a ternary here and a boolean in the Header, which reads as "two
// sections" but is really "one flag" — there is no `!inMusic` once a third
// section exists. Adding one is now a single entry below.

const STORAGE_KEY = 'poisonflix:lastSection';

export type AppSection = 'cine' | 'musica' | 'juegos';

type SectionDef = {
  /** Where the section's own home lives. */
  home: string;
  /** Path prefixes that belong to this section, beyond its home. */
  owns: readonly string[];
  /** Shown on the control that switches into this section. */
  label: string;
};

const SECTIONS = {
  // Cinema owns '/' exactly. It cannot claim a prefix without swallowing every
  // shared page in the app, so it is matched separately in sectionOf.
  cine: { home: '/', owns: [], label: 'Películas y series' },
  // A Jam is listening together, not a second product, so it lives in Música.
  musica: { home: '/musica', owns: ['/musica', '/jam'], label: 'Música' },
  juegos: { home: '/juegos', owns: ['/juegos'], label: 'Juegos' },
} as const satisfies Record<AppSection, SectionDef>;

export const SECTION_ORDER = ['cine', 'musica', 'juegos'] as const;

/** Where the section's own home lives. */
export const SECTION_HOME: Record<AppSection, string> = {
  cine: SECTIONS.cine.home,
  musica: SECTIONS.musica.home,
  juegos: SECTIONS.juegos.home,
};

export function sectionLabel(section: AppSection): string {
  return SECTIONS[section].label;
}

function isSection(value: unknown): value is AppSection {
  // `in` walks the prototype chain, so it answers true for 'toString',
  // 'constructor' and friends — a stored value of 'toString' would then type as
  // AppSection, SECTION_HOME['toString'] would be undefined, and the layout
  // would render <Navigate to={undefined}>. Own keys only.
  return typeof value === 'string' && Object.hasOwn(SECTIONS, value);
}

/** Which section a path belongs to, or null when the path is shared furniture. */
export function sectionOf(pathname: string): AppSection | null {
  for (const section of SECTION_ORDER) {
    for (const prefix of SECTIONS[section].owns) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return section;
    }
  }
  if (pathname === '/') return 'cine';
  // Everything else (a title page, downloads, admin) is shared furniture and
  // says nothing about which section the user considers themselves to be in.
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
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isSection(stored) ? stored : 'cine';
  } catch {
    return 'cine';
  }
}
