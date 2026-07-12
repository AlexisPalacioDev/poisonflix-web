// Presentational-only cleaner for Jellyfin library item names (design.md §1
// `lib/domain/` layer). Some library items are named after their raw
// scene-release folder (e.g. "GalaxyRG265 - The.Matrix.1999.1080p.BluRay.
// DDP5.1.x265.10bit-GalaxyRG265") instead of a clean title. This surfaces
// badly in the hero banner and poster rows.
//
// This is DISPLAY-ONLY: it never touches ids, provider ids, stream resolution
// or any API/playback logic - it just derives a nicer label from a string.
// It is deliberately conservative: it only rewrites names that carry an
// unambiguous scene-release signature (a resolution/codec/source token), so
// ordinary titles like "La noche de los muertos vivientes" or
// "Mission: Impossible - Dead Reckoning" pass through untouched.

const SCENE_SIGNATURE =
  /\b(?:2160p|1080p|720p|480p|bluray|web-?dl|webrip|hdtv|x264|x265|hevc|h\.?264|h\.?265|ddp?5|aac|remux)\b/i;

// The point in the string where scene metadata starts (a year or a quality
// token, preceded by a separator).
const METADATA_START =
  /[.\s_-](?:19\d{2}|20\d{2}|2160p|1080p|720p|480p|bluray|web-?dl|webrip|hdtv|x264|x265|hevc|remux)\b/i;

/**
 * Returns a human-friendly display title. When `raw` looks like a scene
 * release, strips a leading group tag, cuts at the first year/quality token,
 * and normalises `.`/`_` separators to spaces. Otherwise returns `raw`
 * trimmed, unchanged.
 */
export function displayTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!SCENE_SIGNATURE.test(trimmed)) return trimmed;

  // Drop a leading release-group prefix like "GalaxyRG265 - ".
  let s = trimmed.replace(/^[A-Za-z0-9]+\s-\s/, '');

  const cut = s.search(METADATA_START);
  if (cut > 0) s = s.slice(0, cut);

  s = s.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return s.length > 0 ? s : trimmed;
}
