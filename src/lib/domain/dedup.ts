// Pure, framework-free dedup helper (design.md §2 `lib/domain/dedup.ts`),
// ported from `SearchRepositoryImpl.kt` L23's `distinctBy(id)`. Kept generic
// over both the item and key type so it isn't tied to TMDB search results.
export function distinctBy<T, K>(items: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}
