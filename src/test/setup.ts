import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement ResizeObserver, which components use to react to
// layout changes (e.g. Row's scroll-arrow overflow detection). Provide a
// no-op stub so those components mount cleanly under test.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement matchMedia, which `useMediaQuery` (NowPlayingBar's
// mobile/desktop switch) relies on. Default to "no match" (desktop layout) so
// components mount cleanly; individual tests override it to force the compact
// mobile layout.
if (!('matchMedia' in globalThis)) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}
