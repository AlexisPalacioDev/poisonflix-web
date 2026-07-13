import { z } from 'zod';

// AniList GraphQL response schema (`data/remote/dto/AniListDto.kt`). Only the
// subset of `Media` fields the +18 cover/info enrichment needs is modelled;
// every field is defensive (nullable/optional) since the lightweight cover
// query and the richer detail query share this one schema, and GraphQL
// returns `null` for anything not selected by the query.

export const AniListCoverSchema = z.object({
  large: z.string().nullable().optional(),
});

export const AniListTitleSchema = z.object({
  romaji: z.string().nullable().optional(),
  english: z.string().nullable().optional(),
});

export const AniListMediaSchema = z.object({
  coverImage: AniListCoverSchema.nullable().optional(),
  bannerImage: z.string().nullable().optional(),
  title: AniListTitleSchema.nullable().optional(),
  description: z.string().nullable().optional(),
  episodes: z.number().nullable().optional(),
  averageScore: z.number().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
});
export type AniListMedia = z.infer<typeof AniListMediaSchema>;

export const AniListResponseSchema = z.object({
  data: z
    .object({
      // GraphQL field name is "Media" (capitalized) - `AniListDto.kt`'s `AniListData.Media`.
      Media: AniListMediaSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type AniListResponse = z.infer<typeof AniListResponseSchema>;
