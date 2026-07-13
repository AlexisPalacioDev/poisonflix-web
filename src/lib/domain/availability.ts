import { detectLanguages, type ReleaseLanguage } from './releaseLanguage';

// Aggregates a set of torrent releases (from a Prowlarr search) into the
// pre-download "is this out there, and in which languages?" summary the detail
// screen shows. Kept as a pure function over a minimal structural input so it
// is trivially unit-testable and decoupled from the Prowlarr schema.

export interface ReleaseCandidate {
  title: string;
  seeders: number;
  /** TMDB id when the indexer reported one; 0/absent for most torrent trackers. */
  tmdbId?: number | null;
}

export interface LanguageAvailability {
  language: ReleaseLanguage;
  count: number;
  maxSeeders: number;
}

export interface AvailabilitySummary {
  found: boolean;
  totalReleases: number;
  maxSeeders: number;
  /** One entry per detected language, sorted healthiest (most seeders) first. */
  languages: LanguageAvailability[];
}

/**
 * @param releases raw candidates from the Prowlarr search.
 * @param target   the title being viewed; its `tmdbId` filters out clearly
 *                 wrong matches. Releases whose reported tmdbId differs from
 *                 the target are dropped; those with a matching id — or no id
 *                 at all (the common case for public trackers) — are kept.
 */
export function summarizeAvailability(
  releases: ReleaseCandidate[],
  target?: { tmdbId?: number | null },
): AvailabilitySummary {
  const targetId = target?.tmdbId ?? null;

  const relevant = releases.filter((r) => {
    const id = r.tmdbId ?? 0;
    if (targetId == null || id === 0) return true;
    return id === targetId;
  });

  const byLang = new Map<ReleaseLanguage, { count: number; maxSeeders: number }>();
  let maxSeeders = 0;

  for (const r of relevant) {
    const seeders = Number.isFinite(r.seeders) ? Math.max(0, r.seeders) : 0;
    if (seeders > maxSeeders) maxSeeders = seeders;

    for (const lang of detectLanguages(r.title)) {
      const acc = byLang.get(lang) ?? { count: 0, maxSeeders: 0 };
      acc.count += 1;
      if (seeders > acc.maxSeeders) acc.maxSeeders = seeders;
      byLang.set(lang, acc);
    }
  }

  const languages = [...byLang.entries()]
    .map(([language, v]) => ({ language, count: v.count, maxSeeders: v.maxSeeders }))
    .sort((a, b) => b.maxSeeders - a.maxSeeders || b.count - a.count);

  return {
    found: relevant.length > 0,
    totalReleases: relevant.length,
    maxSeeders,
    languages,
  };
}
