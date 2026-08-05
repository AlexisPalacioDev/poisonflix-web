// Chip-collapse priority for the media-languages panel (detail-request
// spec's "Subtitle chip collapse for long lists" + design.md D5b). NOT
// shared with the player's track menu (design.md D5): hiding a subtitle
// track there would hide an action, not summarize a list, so this lives as
// a Detail-only helper rather than in the shared `languageNames.ts`.

export interface PrioritizedLanguages {
  shown: string[];
  hidden: string[];
}

/**
 * Orders already-translated language labels by priority - app language
 * (Español, this app has no i18n so it's a fixed literal), then Inglés, then
 * the file's own default audio language (if present in the list), then the
 * rest in their original order - and splits the result at `limit` into
 * always-visible (`shown`) and collapsed (`hidden`).
 *
 * `defaultLabel` and duplicate priority entries are deduplicated: a label
 * only ever appears once in the combined output, at its highest-priority
 * position.
 */
export function prioritizeLanguages(
  labels: string[],
  defaultLabel: string | null,
  limit = 6,
): PrioritizedLanguages {
  const priorityOrder = ['Español', 'Inglés', ...(defaultLabel ? [defaultLabel] : [])];
  const seen = new Set<string>();
  const prioritized: string[] = [];

  for (const candidate of priorityOrder) {
    if (seen.has(candidate) || !labels.includes(candidate)) continue;
    seen.add(candidate);
    prioritized.push(candidate);
  }

  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    prioritized.push(label);
  }

  return {
    shown: prioritized.slice(0, limit),
    hidden: prioritized.slice(limit),
  };
}
