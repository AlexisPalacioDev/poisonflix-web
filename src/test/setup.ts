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

// jsdom doesn't implement window.scrollTo (it logs "Not implemented" and
// leaves it non-functional). Overlay scroll-lock restores the pre-lock
// scroll position via `window.scrollTo` on unlock, so stub it here once
// instead of mocking it in every overlay test file.
if (typeof window !== 'undefined') {
  window.scrollTo = (() => {}) as typeof window.scrollTo;
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

// jsdom doesn't implement `HTMLTrackElement.track` at all (`trackEl.track`
// is always `undefined`, confirmed against jsdom 25) - the sideloaded
// `<track>` elements the player uses for subtitles (VideoSurface's
// `applySubtitle`, which toggles `track.mode` between 'showing'/'disabled')
// would be untestable without this: any test asserting on real subtitle
// application would either crash on `undefined.mode` or - worse - every
// player test would silently exercise a no-op branch and read green
// regardless of whether subtitles actually got applied to the video. This
// is exactly the gap that let the "menu shows Español checked, but no text
// appears" bug ship unnoticed. One persistent fake `TextTrack`-like object
// per `<track>` element (a real `<track>` starts 'disabled', same as here).
if (typeof HTMLTrackElement !== 'undefined' && !('track' in HTMLTrackElement.prototype)) {
  const fakeTextTracks = new WeakMap<HTMLTrackElement, { mode: string }>();
  Object.defineProperty(HTMLTrackElement.prototype, 'track', {
    configurable: true,
    get(this: HTMLTrackElement) {
      let track = fakeTextTracks.get(this);
      if (!track) {
        track = { mode: 'disabled' };
        fakeTextTracks.set(this, track);
      }
      return track;
    },
  });
}
