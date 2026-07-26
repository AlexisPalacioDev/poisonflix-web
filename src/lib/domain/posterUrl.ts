import type { JellyfinItem } from '../../api/schemas/jellyfin';

// Pure, framework-free poster-URL builders (design.md §1's `lib/domain/`
// layer). Two distinct image origins feed the Home rows (design.md §4/home
// spec): Jellyfin serves its own library artwork; Jellyseerr/TMDB results
// carry a TMDB-relative `posterPath` that resolves against TMDB's CDN.

const JELLYFIN_BASE = import.meta.env.VITE_JELLYFIN_BASE ?? '/jellyfin';
// TMDB's image CDN is a public, external origin (not proxied) - Jellyseerr
// itself returns raw TMDB-relative paths, not resolved URLs.
const TMDB_IMAGE_ORIGIN = 'https://image.tmdb.org/t/p';

/**
 * Builds a Jellyfin `Items/{id}/Images/Primary` URL for a library item, or
 * `null` when the item has no primary image tag at all. `api_key` is
 * appended as a query param (same authenticated-URL pattern already
 * validated live for DirectPlay streaming, `streamResolver.ts` §3.3) so the
 * `<img>` tag doesn't need to carry an `X-Emby-Token` header, which HTML
 * `<img>` cannot send.
 */
export function jellyfinPosterUrl(
  item: Pick<JellyfinItem, 'Id' | 'ImageTags'>,
  token: string | null,
  maxWidth = 400,
): string | null {
  const tag = item.ImageTags?.Primary;
  if (!tag) return null;

  const query = new URLSearchParams({ tag, maxWidth: String(maxWidth), quality: '90' });
  if (token) query.set('api_key', token);

  return `${JELLYFIN_BASE}/Items/${item.Id}/Images/Primary?${query.toString()}`;
}

/**
 * Builds a wide Jellyfin backdrop URL for the Home hero banner. Prefers the
 * item's first `BackdropImageTags` entry (`Images/Backdrop/0`); when the
 * library item has no backdrop, falls back to its primary poster so the hero
 * still renders a real image rather than an empty gradient. Returns `null`
 * only when the item carries neither. Same authenticated `api_key` query
 * pattern as `jellyfinPosterUrl` (an `<img>` can't send an auth header).
 */
export function jellyfinBackdropUrl(
  item: Pick<JellyfinItem, 'Id' | 'ImageTags' | 'BackdropImageTags'>,
  token: string | null,
  maxWidth = 1280,
): string | null {
  const backdropTag = item.BackdropImageTags?.[0];
  if (backdropTag) {
    const query = new URLSearchParams({ tag: backdropTag, maxWidth: String(maxWidth), quality: '85' });
    if (token) query.set('api_key', token);
    return `${JELLYFIN_BASE}/Items/${item.Id}/Images/Backdrop/0?${query.toString()}`;
  }

  const primaryTag = item.ImageTags?.Primary;
  if (primaryTag) {
    const query = new URLSearchParams({ tag: primaryTag, maxWidth: String(maxWidth), quality: '85' });
    if (token) query.set('api_key', token);
    return `${JELLYFIN_BASE}/Items/${item.Id}/Images/Primary?${query.toString()}`;
  }

  return null;
}

/**
 * Builds a Jellyfin `Items/{id}/Images/Primary` URL for an arbitrary item id,
 * with an optional `tag` (cache-busts / pins a specific image; the album step
 * of the fallback chain carries `AlbumPrimaryImageTag`, the artist step has no
 * tag and lets Jellyfin serve the artist's current primary). Same authenticated
 * `api_key`/`maxWidth` query pattern as `jellyfinPosterUrl` so the URL works in
 * an `<img>` tag and MediaSession's `maxWidth` swap (see `mediaSessionArtwork`).
 */
function primaryImageUrl(
  id: string,
  tag: string | null | undefined,
  token: string | null,
  maxWidth: number,
): string {
  const query = new URLSearchParams({ maxWidth: String(maxWidth), quality: '90' });
  if (tag) query.set('tag', tag);
  if (token) query.set('api_key', token);
  return `${JELLYFIN_BASE}/Items/${id}/Images/Primary?${query.toString()}`;
}

/**
 * Cover-art fallback chain for a Jellyfin `Audio` item (the Música feature).
 * A song rarely carries its own artwork, so pick the best available image:
 *
 *   1. the item's own Primary image (`ImageTags.Primary`), else
 *   2. the parent album's cover (`AlbumId` + `AlbumPrimaryImageTag`), else
 *   3. the first credited artist's image (`ArtistItems[0]`, then `AlbumArtists[0]`), else
 *   4. `null` — the UI falls back to the ♪ placeholder.
 *
 * Feeding this into `audioItemToTrack` means every surface that reads
 * `track.coverUrl` — song rows, the now-playing bar, the full-screen player,
 * AND the MediaSession lock-screen artwork — inherits the same fallback.
 */
export function resolveCoverUrl(
  item: Pick<
    JellyfinItem,
    'Id' | 'ImageTags' | 'AlbumId' | 'AlbumPrimaryImageTag' | 'ArtistItems' | 'AlbumArtists'
  >,
  token: string | null,
  maxWidth = 400,
): string | null {
  // 1. The item's own primary artwork.
  const own = jellyfinPosterUrl(item, token, maxWidth);
  if (own) return own;

  // 2. The parent album's cover — only when the album actually has one
  //    (`AlbumPrimaryImageTag` present, mirroring the `ImageTags.Primary` check).
  if (item.AlbumId && item.AlbumPrimaryImageTag) {
    return primaryImageUrl(item.AlbumId, item.AlbumPrimaryImageTag, token, maxWidth);
  }

  // 3. The first credited (or album) artist's image. No tag: Jellyfin serves
  //    the artist's current primary if it has one.
  const artistId = item.ArtistItems?.[0]?.Id ?? item.AlbumArtists?.[0]?.Id ?? null;
  if (artistId) {
    return primaryImageUrl(artistId, null, token, maxWidth);
  }

  // 4. No image anywhere — the UI shows the ♪ placeholder.
  return null;
}

/**
 * Resolves a Jellyseerr/TMDB `posterPath` (e.g. `/abc123.jpg`) against
 * TMDB's public image CDN, or `null` when absent. `size` defaults to the
 * carousel-friendly `w342`; Search's big preview panel requests the wider
 * `w500` variant for its larger poster (search spec: "big preview panel").
 * `w1280` (additive, Slice 6) is Detail's hero backdrop size - same `path`
 * shape, just a wider TMDB image bucket, so this stays one function.
 */
export function tmdbPosterUrl(
  posterPath: string | null | undefined,
  size: 'w342' | 'w500' | 'w1280' = 'w342',
): string | null {
  if (!posterPath) return null;
  return `${TMDB_IMAGE_ORIGIN}/${size}${posterPath}`;
}
