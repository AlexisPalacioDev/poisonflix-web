import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOverlayStackForTests,
  isTopOverlay,
  lockScroll,
  nextOverlaySequence,
  popOverlay,
  pushOverlay,
  unlockScroll,
} from './overlayStack';

// Module-level stack backing OverlayShell's "only the topmost overlay
// responds to Escape" contract, plus a refcounted body scroll-lock shared
// across every overlay instance (design D: `sdd/mobile-music-overhaul`).

describe('overlayStack', () => {
  afterEach(() => {
    __resetOverlayStackForTests();
  });

  describe('push/pop/isTopOverlay', () => {
    it('a single pushed overlay is the top', () => {
      const a = Symbol('a');
      pushOverlay(a, nextOverlaySequence());
      expect(isTopOverlay(a)).toBe(true);
    });

    it('the overlay with the highest sequence number is the top', () => {
      const a = Symbol('a');
      const b = Symbol('b');
      pushOverlay(a, nextOverlaySequence());
      pushOverlay(b, nextOverlaySequence());

      expect(isTopOverlay(b)).toBe(true);
      expect(isTopOverlay(a)).toBe(false);
    });

    it('a higher sequence number wins even if it registers first (child-before-parent effect order)', () => {
      // Mirrors two OverlayShells mounted in the same commit: rendering is
      // parent-first (so the parent grabs the lower sequence number), but
      // React's effects commit child-first (so the child's `pushOverlay`
      // call actually runs before the parent's). The stack must still rank
      // by sequence, not by call order.
      const parent = Symbol('parent');
      const child = Symbol('child');
      const parentSequence = nextOverlaySequence();
      const childSequence = nextOverlaySequence();

      pushOverlay(child, childSequence);
      pushOverlay(parent, parentSequence);

      expect(isTopOverlay(child)).toBe(true);
      expect(isTopOverlay(parent)).toBe(false);
    });

    it('popping the top overlay restores the previous one as top', () => {
      const a = Symbol('a');
      const b = Symbol('b');
      pushOverlay(a, nextOverlaySequence());
      pushOverlay(b, nextOverlaySequence());
      popOverlay(b);

      expect(isTopOverlay(a)).toBe(true);
    });

    it('an id never pushed is never the top', () => {
      expect(isTopOverlay(Symbol('never-pushed'))).toBe(false);
    });
  });

  describe('lockScroll/unlockScroll', () => {
    afterEach(() => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
    });

    it('locks the body with position:fixed pinned at -scrollY, not overflow:hidden', () => {
      Object.defineProperty(window, 'scrollY', { value: 240, configurable: true });
      const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

      lockScroll();

      expect(document.body.style.position).toBe('fixed');
      expect(document.body.style.top).toBe('-240px');
      expect(document.body.style.width).toBe('100%');

      unlockScroll();
      scrollToSpy.mockRestore();
    });

    it('restores scroll position via window.scrollTo on the final unlock', () => {
      Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
      const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

      lockScroll();
      unlockScroll();

      expect(scrollToSpy).toHaveBeenCalledWith(0, 500);
      expect(document.body.style.position).toBe('');

      scrollToSpy.mockRestore();
    });

    it('is refcounted: nested overlays keep the lock until the last one unlocks', () => {
      Object.defineProperty(window, 'scrollY', { value: 100, configurable: true });
      const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

      lockScroll(); // outer overlay opens
      lockScroll(); // inner overlay opens on top
      unlockScroll(); // inner closes - outer is still open

      expect(document.body.style.position).toBe('fixed');
      expect(scrollToSpy).not.toHaveBeenCalled();

      unlockScroll(); // outer closes - now it actually unlocks
      expect(document.body.style.position).toBe('');
      expect(scrollToSpy).toHaveBeenCalledWith(0, 100);

      scrollToSpy.mockRestore();
    });
  });
});
