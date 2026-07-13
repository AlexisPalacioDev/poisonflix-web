// Language detection for torrent release titles.
//
// Prowlarr's raw search results do NOT populate a structured `languages`
// field (confirmed live: it comes back empty), so language has to be inferred
// from the release title itself. This mirrors what Sonarr/Radarr's own release
// parser does internally, distilled to the distinction the user actually asked
// for: is a title available in English, in Spanish, or both.
//
// Convention (matches the *arr parser default): a scene/web release with NO
// explicit foreign-language marker is treated as English. Foreign audio is
// almost always tagged explicitly ("Latino", "Castellano", "VOSTFR", ...),
// so "no marker" reliably means English rather than "unknown".

export type ReleaseLanguage =
  | 'english'
  | 'spanish-latino'
  | 'spanish-castellano'
  | 'spanish'
  | 'french'
  | 'italian'
  | 'portuguese'
  | 'multi';

// Human-facing labels (Rioplatense-neutral Spanish, the app's UI language).
export const RELEASE_LANGUAGE_LABELS: Record<ReleaseLanguage, string> = {
  english: 'Inglés',
  'spanish-latino': 'Español latino',
  'spanish-castellano': 'Español (España)',
  spanish: 'Español',
  french: 'Francés',
  italian: 'Italiano',
  portuguese: 'Portugués',
  multi: 'Multi-idioma',
};

// Ordered so the most specific patterns win before the generic Spanish catch.
// Each entry: a normalized language + a word-boundary-anchored matcher. Short
// ambiguous tokens (e.g. "vf", "lat", "spa") are deliberately excluded to keep
// false positives out — clarity over recall.
const MARKERS: ReadonlyArray<readonly [ReleaseLanguage, RegExp]> = [
  ['multi', /\b(?:multi|dual\s*audio|dual)\b/i],
  ['spanish-latino', /\b(?:latino|latin\s*american|dual\s*lat)\b/i],
  ['spanish-castellano', /\bcastellano\b/i],
  ['spanish', /\b(?:spanish|espa[nñ]ol|subtitulado)\b/i],
  ['french', /\b(?:french|truefrench|vostfr|vff?)\b/i],
  ['italian', /\b(?:italian|ita(?:liano)?)\b/i],
  ['portuguese', /\b(?:portuguese|dublado|nacional|pt[-\s]?br)\b/i],
  ['english', /\b(?:english|eng)\b/i],
];

/**
 * Detect every language marker present in a single release title.
 *
 * Returns a de-duplicated, deterministically ordered list. A "multi" tag
 * implies English audio is present too. When no marker is found at all, the
 * release is reported as English (the scene default described above), so a
 * plain `Movie.2015.1080p.BluRay.x264` correctly reads as English rather than
 * vanishing from the language breakdown.
 */
export function detectLanguages(title: string): ReleaseLanguage[] {
  const found = new Set<ReleaseLanguage>();
  for (const [language, matcher] of MARKERS) {
    if (matcher.test(title)) found.add(language);
  }

  // "Multi"/"Dual" packs bundle English with the other tracks.
  if (found.has('multi')) found.add('english');

  // Collapse the generic 'spanish' tag when a more specific variant is known,
  // so "Español Latino" doesn't count as both 'spanish' and 'spanish-latino'.
  if (found.has('spanish') && (found.has('spanish-latino') || found.has('spanish-castellano'))) {
    found.delete('spanish');
  }

  if (found.size === 0) return ['english'];

  const order: ReleaseLanguage[] = [
    'english',
    'spanish-latino',
    'spanish-castellano',
    'spanish',
    'french',
    'italian',
    'portuguese',
    'multi',
  ];
  return order.filter((lang) => found.has(lang));
}
