import { AniListResponseSchema, type AniListMedia } from './schemas/anilist';

// AniList GraphQL client - cover/info source for +18 content
// (`data/remote/AniListApi.kt`). AniList is a PUBLIC endpoint
// (https://graphql.anilist.co/) that serves permissive CORS headers to
// browsers, so this is the one `api/` module that calls `fetch` DIRECTLY
// instead of going through `lib/http/client.ts`'s `apiFetch` - there is no
// same-origin proxy entry for it (unlike Jellyfin/Jellyseerr/Prowlarr/
// Radarr/Sonarr, which all need the proxy to inject a same-origin
// cookie/API key), and none is needed here since AniList has no auth at all.

const ANILIST_URL = 'https://graphql.anilist.co/';

// Per-request timeout. `fetch` has NO default timeout, so a slow/held AniList
// connection (rate-limited, or just queued behind the browser's ~6-per-host
// connection cap when the +18 row enriches dozens of covers at once) would
// otherwise hang forever - and since the row awaits ALL its cover lookups, one
// stuck request blocks the entire row from ever resolving. OkHttp's default
// timeouts covered this in the Kotlin reference; replicate them here.
const ANILIST_TIMEOUT_MS = 7_000;

/** Single-title search returning just the cover; keeps payloads tiny (`AniListApi.kt`'s `COVER_QUERY`). */
const COVER_QUERY = 'query($s:String){Media(search:$s,type:ANIME){coverImage{large}}}';

/** Full metadata for the +18 info screen (`AniListApi.kt`'s `DETAIL_QUERY`). */
const DETAIL_QUERY =
  'query($s:String){Media(search:$s,type:ANIME){coverImage{large} bannerImage ' +
  'title{romaji english} description(asHtml:false) episodes averageScore genres}}';

const EPISODE_CUT = /[._\s-]*[Ss]\d{1,2}[Ee]\d/;
const QUALITY_CUT = /\b(1080p|2160p|720p|480p|BluRay|WEB-?DL|WEBRip|HDTV|UNCENSORED|x264|x265|H\.?264|AAC.*)\b/i;

/**
 * Reduces a raw torrent/release name to a searchable show title for AniList
 * (`MediaRepositoryImpl.kt`'s `cleanShowTitle`): drops a leading "[group]"
 * tag, cuts at the SxxEyy marker or the first quality token, and normalizes
 * separators. `"[HentaiHub] Do You Like Big Girls S01E04 1080p..."` ->
 * `"Do You Like Big Girls"`. Exported so `useAdultRow`'s per-show collapse
 * uses the exact same normalization AniList is queried with.
 */
export function cleanReleaseTitle(raw: string): string {
  let s = raw.replace(/^\[[^\]]*\]\s*/, '');
  s = s.split(EPISODE_CUT)[0] ?? s;
  s = s.split(QUALITY_CUT)[0] ?? s;
  s = s.replace(/[._]/g, ' ');
  return s
    .trim()
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** AniList descriptions still carry `<br>`/basic tags even with `asHtml:false` - strip for plain display. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

async function queryAniList(query: string, title: string): Promise<AniListMedia | null> {
  const cleaned = cleanReleaseTitle(title);
  if (!cleaned) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANILIST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { s: cleaned } }),
      signal: controller.signal,
    });
  } catch {
    // Network failure (offline, DNS) OR the timeout aborting a stuck request -
    // degrade to "no metadata" instead of throwing; a missing/slow AniList
    // cover must never crash OR hang the +18 row.
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return null;

  const data = await response.json().catch(() => undefined);
  const parsed = AniListResponseSchema.safeParse(data);
  if (!parsed.success) return null;

  return parsed.data.data?.Media ?? null;
}

/** Single-title cover lookup (adult row/library poster enrichment). */
export async function getAnilistCover(title: string): Promise<string | null> {
  const media = await queryAniList(COVER_QUERY, title);
  return media?.coverImage?.large ?? null;
}

export interface AnilistInfo {
  title: string;
  synopsis: string | null;
  posterUrl: string | null;
  bannerUrl: string | null;
  episodes: number | null;
  score: number | null;
  genres: string[];
}

/** Full metadata lookup (+18 search screen's big-preview panel). */
export async function getAnilistInfo(title: string): Promise<AnilistInfo | null> {
  const media = await queryAniList(DETAIL_QUERY, title);
  if (!media) return null;

  return {
    title: media.title?.english ?? media.title?.romaji ?? cleanReleaseTitle(title),
    synopsis: media.description ? stripHtml(media.description) : null,
    posterUrl: media.coverImage?.large ?? null,
    bannerUrl: media.bannerImage ?? null,
    episodes: media.episodes ?? null,
    score: media.averageScore ?? null,
    genres: media.genres ?? [],
  };
}
