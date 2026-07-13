// Genre/category catalog for Home's 10 mixed genre rows (projector-feature-map.md
// §3, `domain/model/Category.kt:29-45` `CategoryCatalog.NORMAL`). Order matters:
// this is the exact render order of the rows on Home, ported verbatim from the
// native catalog. The adult category (`CategoryCatalog.ADULT`) is out of scope
// here - it is gated behind a separate PIN-unlock flow the web app doesn't
// implement yet.

export interface Category {
  id: string;
  label: string;
  jellyfinGenre: string;
  tmdbGenreId: number;
}

export const NORMAL_CATEGORIES: Category[] = [
  { id: 'action', label: 'Acción', jellyfinGenre: 'Acción', tmdbGenreId: 28 },
  { id: 'comedy', label: 'Comedia', jellyfinGenre: 'Comedia', tmdbGenreId: 35 },
  { id: 'horror', label: 'Terror', jellyfinGenre: 'Terror', tmdbGenreId: 27 },
  { id: 'scifi', label: 'Ciencia ficción', jellyfinGenre: 'Ciencia ficción', tmdbGenreId: 878 },
  { id: 'drama', label: 'Drama', jellyfinGenre: 'Drama', tmdbGenreId: 18 },
  { id: 'animation', label: 'Animación', jellyfinGenre: 'Animación', tmdbGenreId: 16 },
  { id: 'crime', label: 'Crimen', jellyfinGenre: 'Crimen', tmdbGenreId: 80 },
  { id: 'romance', label: 'Romance', jellyfinGenre: 'Romance', tmdbGenreId: 10749 },
  { id: 'adventure', label: 'Aventura', jellyfinGenre: 'Aventura', tmdbGenreId: 12 },
  { id: 'thriller', label: 'Suspense', jellyfinGenre: 'Suspense', tmdbGenreId: 53 },
];
