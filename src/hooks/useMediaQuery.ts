import { useEffect, useState } from 'react';

// Subscribes to a CSS media query and re-renders when it flips. Used by the
// NowPlayingBar to switch between the desktop 3-column bar and the compact
// mobile now-playing bar + full-screen player.
//
// SSR / jsdom-safe: when `matchMedia` is unavailable the hook reports `false`
// (the desktop layout) rather than throwing. The test setup provides a stub so
// components mount cleanly; tests override it to force the compact layout.
export function useMediaQuery(query: string): boolean {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    // `addEventListener` is the modern API; `addListener` is the Safari <14
    // fallback. Both are guarded because jsdom stubs may omit one.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}
