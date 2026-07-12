import type { JellyfinItem } from '../../api/schemas/jellyfin';

// Correlates Jellyseerr TMDB results with Jellyfin library presence, ported
// from `LibraryIndex.kt` + `TitleStatus.kt` (design.md §4.4, search spec).
//
// NOTE (deviation from tasks.md slice boundary): tasks.md originally places
// this file in Slice 5 (task 5.3). It is pulled forward into Slice 1 because
// it is pure, framework-free, network-free domain logic with no UI
// dependency - the same rationale that puts it under `lib/domain/` in the
// first place - and building it now lets it be unit-tested alongside the
// rest of the foundation layer. Flagged explicitly, not silently done.

export type TitleStatus =
  | { kind: 'InLibrary'; jellyfinItemId: string; matchedByFallback: boolean }
  | { kind: 'Requesting'; jellyseerrStatus: number }
  | { kind: 'Requestable' };

/**
 * Human-readable label for a Jellyseerr `mediaInfo.status` (1-5), mirroring
 * `jellyseerrStatusLabel` in `TitleStatus.kt` verbatim so the same status
 * number always reads the same way across the app.
 */
export function jellyseerrStatusLabel(status: number): string {
  switch (status) {
    case 2:
      return 'Pendiente';
    case 3:
      return 'Descargando';
    case 4:
      return 'Parcialmente disponible';
    case 5:
      return 'Disponible';
    default:
      return 'Descargando';
  }
}

function normalizedKey(title: string, year: number): string {
  return `${title.trim().toLowerCase()}|${year}`;
}

export class LibraryIndex {
  // tmdbId (as Jellyfin's string ProviderIds value) -> jellyfinItemId.
  private readonly byTmdbId = new Map<string, string>();
  // Fallback index, only for items with no Tmdb provider id at all.
  private readonly byTitleYear = new Map<string, string>();

  constructor(jellyfinItems: JellyfinItem[]) {
    for (const item of jellyfinItems) {
      const tmdbId = item.ProviderIds?.Tmdb;
      if (tmdbId) {
        this.byTmdbId.set(tmdbId, item.Id);
        continue;
      }
      if (item.ProductionYear != null) {
        this.byTitleYear.set(normalizedKey(item.Name, item.ProductionYear), item.Id);
      }
    }
  }

  /**
   * Resolves the unified TitleStatus for one TMDB search result.
   *
   * @param tmdbId TMDB id of the searched title.
   * @param title title as returned by Jellyseerr/TMDB - used only for the fallback match.
   * @param releaseYear release year parsed from Jellyseerr/TMDB's date string - used only for the fallback match.
   * @param jellyseerrStatus Jellyseerr's `mediaInfo.status` (1-5), or null if no Jellyseerr media record exists yet.
   */
  resolve(
    tmdbId: number,
    title: string,
    releaseYear: number | null,
    jellyseerrStatus: number | null,
  ): TitleStatus {
    const byId = this.byTmdbId.get(String(tmdbId));
    if (byId) {
      return { kind: 'InLibrary', jellyfinItemId: byId, matchedByFallback: false };
    }

    if (releaseYear != null) {
      const byTitle = this.byTitleYear.get(normalizedKey(title, releaseYear));
      if (byTitle) {
        return { kind: 'InLibrary', jellyfinItemId: byTitle, matchedByFallback: true };
      }
    }

    // 5 = AVAILABLE is Jellyseerr's own "already in library" signal.
    // Jellyfin presence above already covers the reproducible case; this is
    // belt-and-suspenders for correlation drift between the two backends.
    if (jellyseerrStatus == null || jellyseerrStatus === 5) {
      return { kind: 'Requestable' };
    }

    return { kind: 'Requesting', jellyseerrStatus };
  }
}
