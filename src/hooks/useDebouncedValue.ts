import { useEffect, useState } from 'react';

// 350ms debounce primitive, ported from `SearchViewModel.kt` L106-119
// (design.md §4.3, search spec).
//
// NOTE (deviation from tasks.md slice boundary): tasks.md originally places
// this in Slice 5 (task 5.1). Pulled forward into Slice 1 as a foundational,
// pure hook with no UI dependency, per this batch's delegation scope.
// Flagged explicitly, not silently done.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
