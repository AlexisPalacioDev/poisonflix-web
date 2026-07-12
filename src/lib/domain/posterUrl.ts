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
