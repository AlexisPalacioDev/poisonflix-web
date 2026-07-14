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
