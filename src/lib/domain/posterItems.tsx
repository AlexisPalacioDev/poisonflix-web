import { StatusBadge } from '../../components/StatusBadge';
import type { PosterItem } from '../../components/PosterCard';
import type { GenreRowItem } from '../../hooks/useGenreRow';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import type { JellyseerrSearchResult } from '../../api/schemas/jellyseerr';
import { displayTitle } from './displayTitle';
import { jellyfinPosterUrl, tmdbPosterUrl } from './posterUrl';

// Shared API-shape -> `PosterItem` mappers. Each Home row wraps one of these,
// and its `/` "ver todo" grid screen wraps the SAME one, so a poster renders
// identically whether it appears on a rail or a full grid. Centralised on
// purpose: the TV-tagging rule below (mediaType MUST be carried or /detail/:id
// opens the unrelated movie sharing that TMDB id) has to stay identical in
// both places - two copies would eventually drift into a real routing bug.

// --- Library (Jellyfin) ----------------------------------------------------

export function toLibraryPosterItem(item: JellyfinItem, token: string | null): PosterItem {
  return {
    // Detail's route param is a TMDB id (design.md §7). A library item
    // normally carries one via ProviderIds.Tmdb; when it doesn't, fall back
    // to the Jellyfin item id so the card is still clickable.
    id: item.ProviderIds?.Tmdb ?? item.Id,
    title: displayTitle(item.Name),
    imageUrl: jellyfinPosterUrl(item, token),
    // Series must be tagged so PosterCard routes to /detail/:id?type=tv
    // (TMDB reuses ids across the movie/tv namespaces); omitted -> movie.
    mediaType: item.Type === 'Series' ? 'tv' : 'movie',
  };
}

// --- Trending (Jellyseerr) -------------------------------------------------

export function toTrendingPosterItem(result: JellyseerrSearchResult): PosterItem {
  return {
    id: String(result.id),
    title: result.title ?? result.name ?? 'Sin título',
    imageUrl: tmdbPosterUrl(result.posterPath),
    // TMDB reuses numeric ids across the movie and tv namespaces, so a TV
    // result MUST be tagged - otherwise /detail/:id resolves it as the movie
    // with the same id and opens a completely unrelated title.
    mediaType: result.mediaType === 'tv' ? 'tv' : 'movie',
  };
}

// Trending mixes movie/tv/person results; only titles a poster + Detail route
// make sense for are shown. Shared by Home's row and the /trending grid so
// both surface the exact same set.
export function trendingPosterItems(results: JellyseerrSearchResult[]): PosterItem[] {
  return results
    .filter((result) => result.mediaType === 'movie' || result.mediaType === 'tv')
    .map(toTrendingPosterItem);
}

// --- Genre / category (library + TMDB discover merge) ----------------------

export function toGenreRowPosterItem(entry: GenreRowItem, token: string | null): PosterItem {
  const imageUrl = entry.jellyfinItem
    ? jellyfinPosterUrl(entry.jellyfinItem, token)
    : tmdbPosterUrl(entry.posterPath);

  return {
    id: entry.id,
    title: entry.title,
    imageUrl,
    mediaType: entry.mediaType,
    // PEDIR pill only on unowned titles (projector-feature-map.md §3's
    // MediaRow badge rule) - InLibrary items render with no badge; anything
    // else (Requesting/Requestable) is still "not yet in your library".
    badge: entry.status.kind !== 'InLibrary' ? <StatusBadge variant="requestable" label="PEDIR" /> : undefined,
  };
}

// --- Continue watching (Jellyfin resume feed) ------------------------------

// Progress percent is derived from PlaybackPositionTicks/RunTimeTicks rather
// than a `UserData.PlayedPercentage` field: the zod schema
// (api/schemas/jellyfin.ts) doesn't declare that field, so it would be
// silently stripped from the parsed response; the ticks ratio is equivalent
// data that IS already declared.
function resumePercent(item: JellyfinItem): number | undefined {
  const positionTicks = item.UserData?.PlaybackPositionTicks;
  const totalTicks = item.RunTimeTicks;
  if (!positionTicks || !totalTicks) return undefined;
  return Math.min(100, Math.max(0, (positionTicks / totalTicks) * 100));
}

export function toResumePosterItem(item: JellyfinItem, token: string | null): PosterItem {
  return {
    id: item.Id,
    title: displayTitle(item.Name),
    imageUrl: jellyfinPosterUrl(item, token),
    // Bar-only (dimUnwatched omitted -> defaults to false), per walkthrough §2:
    // "Every card has a thin amber progress bar under the poster".
    progressPercent: resumePercent(item),
  };
}
