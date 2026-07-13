import { z } from 'zod';

// Prowlarr manual-search schema: GET /api/v1/search. Only the subset of fields
// the availability preview needs is modelled; Prowlarr returns many more.
// `languages` comes back empty from Prowlarr (confirmed live) — language is
// inferred from the title instead (see lib/domain/releaseLanguage.ts), so it
// is intentionally not part of this schema.
//
// `.passthrough()` keeps unknown fields from failing validation, and every
// modelled field is defensive (nullable/optional with a default) because the
// exact payload varies per indexer.

export const ProwlarrReleaseSchema = z
  .object({
    guid: z.string().nullable().optional(),
    title: z.string(),
    indexer: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    seeders: z.number().nullable().optional().default(0),
    leechers: z.number().nullable().optional().default(0),
    protocol: z.string().nullable().optional(),
    tmdbId: z.number().nullable().optional().default(0),
    imdbId: z.string().nullable().optional(),
    tvdbId: z.number().nullable().optional().default(0),
    publishDate: z.string().nullable().optional(),
  })
  .passthrough();
export type ProwlarrRelease = z.infer<typeof ProwlarrReleaseSchema>;

export const ProwlarrSearchResponseSchema = z.array(ProwlarrReleaseSchema);
export type ProwlarrSearchResponse = z.infer<typeof ProwlarrSearchResponseSchema>;
